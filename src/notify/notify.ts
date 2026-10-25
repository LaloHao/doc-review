// Notifications. Channels are independent: Telegram (owner), email to the owner,
// and opt-in email to directors when a new version is published. Each one is off
// unless configured. Messages never carry secrets: links point to the public URL,
// and a director's personal link goes by email only when the owner asks for it.
// Failures are logged (without credentials) and never break the request.

import type { Config } from "../config.js";
import type { Director, ThreadOut, Version } from "../repo.js";
import { excerpt } from "../text.js";

export interface Mail {
  to: string;
  subject: string;
  text: string;
}

export interface Mailer {
  send(mail: Mail): Promise<void>;
}

export interface Telegram {
  send(text: string): Promise<void>;
}

export function telegramClient(
  c: { botToken: string; chatId: string },
  fetchImpl: typeof fetch = fetch,
): Telegram {
  return {
    async send(text) {
      const res = await fetchImpl(`https://api.telegram.org/bot${c.botToken}/sendMessage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        // Plain text (no parse_mode): comment text can't inject formatting.
        body: JSON.stringify({ chat_id: c.chatId, text: text.slice(0, 4000), disable_web_page_preview: true }),
        signal: AbortSignal.timeout(10_000),
      });
      // Never include the URL in errors: it contains the bot token.
      if (!res.ok) throw new Error(`Telegram sendMessage failed: HTTP ${res.status}`);
    },
  };
}

export async function smtpMailer(c: NonNullable<Config["smtp"]>): Promise<Mailer> {
  const { createTransport } = await import("nodemailer");
  const transport = createTransport({
    host: c.host,
    port: c.port,
    secure: c.security === "tls",
    requireTLS: c.security === "starttls",
    ignoreTLS: c.security === "none",
    auth: c.user ? { user: c.user, pass: c.password } : undefined,
    connectionTimeout: 15_000,
    greetingTimeout: 15_000,
    socketTimeout: 30_000,
    logger: false,
    debug: false,
  });
  return {
    async send(mail) {
      await transport.sendMail({ from: c.from, to: mail.to, subject: mail.subject, text: mail.text });
    },
  };
}

export interface NotifierDeps {
  publicUrl: string;
  thesisTitle: () => Promise<string>;
  telegram: Telegram | null;
  mailer: Mailer | null;
  ownerEmail: string;
  instant: boolean;
  log?: (msg: string) => void;
}

export function threadUrl(publicUrl: string, t: { version: number; id: number }): string {
  return `${publicUrl}/v/${t.version}#hilo-${t.id}`;
}

function commentText(t: ThreadOut, commentId: number, publicUrl: string): { title: string; body: string } {
  const c = t.comments.find((x) => x.id === commentId) ?? t.comments[t.comments.length - 1]!;
  const isReply = t.comments[0]?.id !== c.id;
  const where = [`versión ${t.version}`, `página ${t.page}`, t.chapter ? t.chapter.title : null].filter(Boolean).join(", ");
  const title = `${isReply ? "Respuesta" : "Comentario nuevo"} de ${c.author.name}`;
  const lines = [
    `${title} (${where})`,
    t.quote ? `«${excerpt(t.quote, 200)}»` : null,
    "",
    excerpt(c.body ?? "", 1500),
    "",
    threadUrl(publicUrl, t),
  ].filter((l) => l !== null);
  return { title, body: lines.join("\n") };
}

export class Notifier {
  constructor(private readonly d: NotifierDeps) {}

  get enabled(): { telegram: boolean; ownerEmail: boolean; directorEmail: boolean } {
    return {
      telegram: this.d.telegram !== null,
      ownerEmail: this.d.mailer !== null && this.d.ownerEmail !== "",
      directorEmail: this.d.mailer !== null,
    };
  }

  private log(msg: string): void {
    (this.d.log ?? console.error)(msg);
  }

  private async toOwner(subject: string, text: string): Promise<void> {
    const jobs: Promise<void>[] = [];
    if (this.d.telegram) jobs.push(this.d.telegram.send(text));
    if (this.d.mailer && this.d.ownerEmail) jobs.push(this.d.mailer.send({ to: this.d.ownerEmail, subject, text }));
    const results = await Promise.allSettled(jobs);
    for (const r of results) if (r.status === "rejected") this.log(`notification failed: ${(r.reason as Error).message}`);
  }

  /** A director wrote a comment or reply. Owner-authored comments don't notify. */
  async commentCreated(thread: ThreadOut, commentId: number): Promise<void> {
    if (!this.d.instant) return;
    const c = thread.comments.find((x) => x.id === commentId);
    if (!c || c.author.kind === "owner") return;
    const { title, body } = commentText(thread, commentId, this.d.publicUrl);
    await this.toOwner(`[Revisión de tesis] ${title}`, body);
  }

  /** Daily summary of what directors wrote since `since`. */
  async digest(threads: ThreadOut[], since: Date): Promise<boolean> {
    const items = threads.flatMap((t) =>
      t.comments
        .filter((c) => c.author.kind === "director" && !c.deleted && Date.parse(c.created_at) >= since.getTime())
        .map((c) => ({ t, c })),
    );
    if (items.length === 0) return false;
    const lines = [`Resumen diario: ${items.length} comentario(s) nuevo(s) de tus directores.`, ""];
    for (const { t, c } of items.slice(0, 50)) {
      lines.push(`• ${c.author.name} — v${t.version}, p. ${t.page}${t.chapter ? `, ${t.chapter.title}` : ""}`);
      lines.push(`  ${excerpt(c.body ?? "", 200)}`);
      lines.push(`  ${threadUrl(this.d.publicUrl, t)}`);
    }
    if (items.length > 50) lines.push(`… y ${items.length - 50} más.`);
    await this.toOwner(`[Revisión de tesis] Resumen: ${items.length} comentario(s)`, lines.join("\n"));
    return true;
  }

  /** New version published: email the directors that opted in (no secret link). */
  async versionPublished(version: Version, directors: Director[]): Promise<void> {
    if (!this.d.mailer) return;
    const title = await this.d.thesisTitle();
    const to = directors.filter((d) => d.notify_versions && d.email && !d.revoked_at);
    const results = await Promise.allSettled(
      to.map((d) =>
        this.d.mailer!.send({
          to: d.email!,
          subject: `Nueva versión de la tesis (v${version.number})`,
          text: [
            `Estimado(a) ${d.name}:`,
            "",
            `Se publicó la versión ${version.number} de la tesis «${title}».`,
            version.note ? `\nNota de la versión:\n${excerpt(version.note, 2000)}\n` : "",
            `Puede revisarla en ${this.d.publicUrl}/ desde el navegador donde abrió su enlace personal.`,
            "Si no tiene ese navegador a mano, use el enlace personal que se le envió por separado.",
            "",
            "Gracias por su revisión.",
          ].join("\n"),
        }),
      ),
    );
    for (const r of results) if (r.status === "rejected") this.log(`version email failed: ${(r.reason as Error).message}`);
  }

  /** Sends a director their personal link (only when the owner explicitly asks). */
  async sendLink(director: Director, link: string): Promise<void> {
    if (!this.d.mailer) throw new Error("El correo no está configurado.");
    if (!director.email) throw new Error("El director no tiene correo registrado.");
    const title = await this.d.thesisTitle();
    await this.d.mailer.send({
      to: director.email,
      subject: "Su enlace para revisar la tesis",
      text: [
        `Estimado(a) ${director.name}:`,
        "",
        `Este es su enlace personal para revisar y comentar la tesis «${title}»:`,
        "",
        link,
        "",
        "El enlace es personal: identifica sus comentarios con su nombre. No lo comparta.",
        "Al abrirlo, el navegador recordará su acceso.",
      ].join("\n"),
    });
  }
}
