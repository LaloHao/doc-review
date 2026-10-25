// Notifications. Channels are independent: Telegram (owner), email to the owner,
// and opt-in emails to reviewers (a new version; replies in their threads, at
// once or as a daily digest). Each one is off unless configured. Messages are in
// the document's language and never carry secrets: links point to the public
// URL, and a reviewer's personal link goes by email only when the owner asks for
// it. Failures are logged (without credentials) and never break the request.

import type { Config } from "../config.js";
import { translator, type Lang, type Tr } from "../i18n/index.js";
import type { CommentOut, Person, ThreadOut, Version } from "../repo.js";
import { excerpt } from "../text.js";

/** Names and titles: one line, without control or bidi characters. */
const name = (s: string | null | undefined) => excerpt(s ?? "", 300);

/** What a notification needs to know about the document. */
export interface DocInfo {
  slug: string;
  title: string;
  language: Lang;
}

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

export function telegramClient(c: { botToken: string; chatId: string }, fetchImpl: typeof fetch = fetch): Telegram {
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
  telegram: Telegram | null;
  mailer: Mailer | null;
  ownerEmail: string;
  instant: boolean;
  log?: (msg: string) => void;
}

export function threadUrl(publicUrl: string, t: { document: string; version: number; id: number }): string {
  return `${publicUrl}/d/${t.document}/v/${t.version}#thread-${t.id}`;
}

/** "[Document title] subject", the title shortened. */
const subject = (doc: DocInfo, text: string) => `[${excerpt(doc.title, 60)}] ${text}`;

function where(tr: Tr, t: ThreadOut): string {
  return [tr("mail.where_version", { n: t.version }), tr("mail.where_page", { n: t.page }), t.section ? name(t.section.title) : null]
    .filter(Boolean)
    .join(", ");
}

const authorName = (c: { author: { name: string; role: string } }) =>
  c.author.role ? `${name(c.author.name)} (${name(c.author.role)})` : name(c.author.name);

export class Notifier {
  constructor(private readonly d: NotifierDeps) {}

  get enabled(): { telegram: boolean; ownerEmail: boolean; reviewerEmail: boolean } {
    return {
      telegram: this.d.telegram !== null,
      ownerEmail: this.d.mailer !== null && this.d.ownerEmail !== "",
      reviewerEmail: this.d.mailer !== null,
    };
  }

  private log(msg: string): void {
    (this.d.log ?? console.error)(msg);
  }

  private url(t: ThreadOut): string {
    return threadUrl(this.d.publicUrl, t);
  }

  private footer(tr: Tr): string[] {
    return ["", tr("mail.reviewer_footer_link"), tr("mail.reviewer_footer_settings", { url: `${this.d.publicUrl}/notifications` })];
  }

  /** Sends on every owner channel; returns how many succeeded and failed. */
  private async toOwner(subj: string, text: string): Promise<{ ok: number; failed: number }> {
    const jobs: Promise<void>[] = [];
    if (this.d.telegram) jobs.push(this.d.telegram.send(text));
    if (this.d.mailer && this.d.ownerEmail) jobs.push(this.d.mailer.send({ to: this.d.ownerEmail, subject: subj, text }));
    const results = await Promise.allSettled(jobs);
    for (const r of results) if (r.status === "rejected") this.log(`notification failed: ${(r.reason as Error).message}`);
    const failed = results.filter((r) => r.status === "rejected").length;
    return { ok: results.length - failed, failed };
  }

  /** A reviewer wrote a comment or reply. Owner-authored comments don't notify. */
  async commentCreated(doc: DocInfo, thread: ThreadOut, commentId: number): Promise<void> {
    if (!this.d.instant) return;
    const c = thread.comments.find((x) => x.id === commentId);
    if (!c || c.author.kind === "owner") return;
    const tr = translator(doc.language);
    const isReply = thread.comments[0]?.id !== c.id;
    const title = tr(isReply ? "mail.reply_from" : "mail.comment_from", { name: authorName(c) });
    const text = [
      `${title} (${where(tr, thread)})`,
      name(doc.title),
      thread.quote ? `«${excerpt(thread.quote, 200)}»` : null,
      "",
      excerpt(c.body ?? "", 1500),
      "",
      this.url(thread),
    ].filter((l) => l !== null);
    await this.toOwner(subject(doc, title), text.join("\n"));
  }

  /** A reviewer edited a comment: the owner sees what changed. */
  async commentEdited(doc: DocInfo, thread: ThreadOut, commentId: number, previous: string): Promise<void> {
    if (!this.d.instant) return;
    const c = thread.comments.find((x) => x.id === commentId);
    if (!c || c.author.kind === "owner") return;
    const tr = translator(doc.language);
    const title = tr("mail.edited", { name: authorName(c) });
    const text = [
      `${title} (${where(tr, thread)})`,
      name(doc.title),
      "",
      tr("mail.before"),
      excerpt(previous, 1000),
      "",
      tr("mail.now"),
      excerpt(c.body ?? "", 1500),
      "",
      this.url(thread),
    ].join("\n");
    await this.toOwner(subject(doc, title), text);
  }

  /**
   * A document's daily summary of what reviewers wrote since `since`. "failed"
   * when every channel failed (the caller retries later); "empty" when there was
   * nothing.
   */
  async digest(doc: DocInfo, threads: ThreadOut[], since: Date): Promise<"sent" | "empty" | "failed"> {
    const items = threads.flatMap((t) =>
      t.comments
        .filter((c) => c.author.kind === "reviewer" && !c.deleted && Date.parse(c.created_at) >= since.getTime())
        .map((c) => ({ t, c })),
    );
    if (items.length === 0) return "empty";
    const tr = translator(doc.language);
    const lines = [tr("mail.digest_intro", { n: items.length, title: name(doc.title) }), ""];
    for (const { t, c } of items.slice(0, 50)) {
      lines.push(`• ${authorName(c)} — ${where(tr, t)}`);
      lines.push(`  ${excerpt(c.body ?? "", 200)}`);
      lines.push(`  ${this.url(t)}`);
    }
    if (items.length > 50) lines.push(tr("mail.and_more", { n: items.length - 50 }));
    const r = await this.toOwner(subject(doc, tr("mail.digest_subject", { n: items.length })), lines.join("\n"));
    return r.failed > 0 && r.ok === 0 ? "failed" : "sent";
  }

  /** Someone else replied in a thread a reviewer takes part in (no secret link). */
  async replyToReviewer(doc: DocInfo, person: Person, thread: ThreadOut, comment: CommentOut): Promise<void> {
    if (!this.d.mailer || !person.email) return;
    const tr = translator(doc.language);
    await this.d.mailer.send({
      to: person.email,
      subject: subject(doc, tr("mail.reply_from", { name: authorName(comment) })),
      text: [
        tr("mail.greeting", { name: name(person.name) }),
        "",
        tr("mail.reply_body", { name: authorName(comment), where: where(tr, thread), title: name(doc.title) }),
        thread.quote ? `«${excerpt(thread.quote, 200)}»` : null,
        "",
        excerpt(comment.body ?? "", 1500),
        "",
        tr("mail.see_thread", { url: this.url(thread) }),
        ...this.footer(tr),
      ]
        .filter((l) => l !== null)
        .join("\n"),
    });
  }

  /** A reviewer's daily digest of replies in one document. Throws if the email can't be sent. */
  async reviewerDigest(doc: DocInfo, person: Person, items: { thread: ThreadOut; comment: CommentOut }[]): Promise<boolean> {
    if (!this.d.mailer || !person.email || items.length === 0) return false;
    const tr = translator(doc.language);
    const lines = [tr("mail.greeting", { name: name(person.name) }), "", tr("mail.reviewer_digest_intro", { n: items.length, title: name(doc.title) }), ""];
    for (const { thread: t, comment: c } of items.slice(0, 50)) {
      lines.push(`• ${authorName(c)} — ${where(tr, t)}`);
      lines.push(`  ${excerpt(c.body ?? "", 300)}`);
      lines.push(`  ${this.url(t)}`);
    }
    if (items.length > 50) lines.push(tr("mail.and_more", { n: items.length - 50 }));
    lines.push(...this.footer(tr));
    await this.d.mailer.send({ to: person.email, subject: subject(doc, tr("mail.reviewer_digest_subject", { n: items.length })), text: lines.join("\n") });
    return true;
  }

  /** New version published: email the document's reviewers that opted in (no secret link). */
  async versionPublished(doc: DocInfo, version: Version, people: Person[]): Promise<void> {
    if (!this.d.mailer) return;
    const tr = translator(doc.language);
    const to = people.filter((p) => p.notify_versions && p.email);
    const results = await Promise.allSettled(
      to.map((p) =>
        this.d.mailer!.send({
          to: p.email!,
          subject: subject(doc, tr("mail.version_subject", { n: version.number })),
          text: [
            tr("mail.greeting", { name: name(p.name) }),
            "",
            tr("mail.version_body", { n: version.number, title: name(doc.title) }),
            version.note ? `\n${tr("mail.version_note")}\n${excerpt(version.note, 2000)}\n` : "",
            tr("mail.version_where", { url: `${this.d.publicUrl}/d/${doc.slug}/v/${version.number}` }),
            tr("mail.version_link_hint"),
            ...this.footer(tr),
          ].join("\n"),
        }),
      ),
    );
    for (const r of results) if (r.status === "rejected") this.log(`version email failed: ${(r.reason as Error).message}`);
  }

  /** Sends a reviewer their personal link to a document (only when the owner explicitly asks). */
  async sendLink(doc: DocInfo, person: Person, link: string): Promise<void> {
    const tr = translator(doc.language);
    if (!this.d.mailer) throw new Error(tr("mail.not_configured"));
    if (!person.email) throw new Error(tr("mail.no_address"));
    await this.d.mailer.send({
      to: person.email,
      subject: subject(doc, tr("mail.link_subject")),
      text: [
        tr("mail.greeting", { name: name(person.name) }),
        "",
        tr("mail.link_body", { title: name(doc.title) }),
        "",
        link,
        "",
        tr("mail.link_personal"),
        tr("mail.link_remember"),
      ].join("\n"),
    });
  }
}
