// A minimal SMTP server for the smoke test: accepts every message on
// 127.0.0.1 (no TLS, no auth) and appends it to a JSON-lines file.
//
//   node scripts/fake-smtp.mjs PORT OUT.jsonl

import { appendFileSync } from "node:fs";
import { createServer } from "node:net";

const [port = "2525", out = "mails.jsonl"] = process.argv.slice(2);

const qp = (s) =>
  Buffer.from(
    s.replace(/=\n/g, "").replace(/=([0-9A-F]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16))),
    "latin1",
  ).toString("utf8");

/** Decodes =?UTF-8?Q?…?= and =?UTF-8?B?…?= words of a header. */
const header = (s) =>
  s.replace(/=\?utf-8\?([qb])\?([^?]*)\?=\s*/gi, (_, enc, text) =>
    enc.toLowerCase() === "b" ? Buffer.from(text, "base64").toString("utf8") : qp(text.replace(/_/g, " ")),
  );

function parse(raw) {
  const at = raw.indexOf("\n\n");
  const head = raw.slice(0, at).replace(/\n[ \t]+/g, " ");
  let body = raw.slice(at + 2);
  const cte = /^Content-Transfer-Encoding: (.*)$/im.exec(head)?.[1]?.trim().toLowerCase();
  if (cte === "quoted-printable") body = qp(body);
  else if (cte === "base64") body = Buffer.from(body.replace(/\s+/g, ""), "base64").toString("utf8");
  return { subject: header(/^Subject: (.*)$/im.exec(head)?.[1] ?? ""), text: body };
}

createServer((sock) => {
  let buf = "";
  let data = null;
  let rcpt = [];
  const reply = (s) => sock.write(s + "\r\n");
  reply("220 fake-smtp ready");
  sock.on("data", (chunk) => {
    buf += chunk.toString("utf8");
    let i;
    while ((i = buf.indexOf("\r\n")) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 2);
      if (data !== null) {
        if (line === ".") {
          appendFileSync(out, JSON.stringify({ to: rcpt, ...parse(data.join("\n")) }) + "\n");
          data = null;
          rcpt = [];
          reply("250 queued");
        } else data.push(line.startsWith("..") ? line.slice(1) : line);
        continue;
      }
      const cmd = line.slice(0, 4).toUpperCase();
      if (cmd === "EHLO") reply("250-fake-smtp\r\n250 8BITMIME");
      else if (cmd === "HELO") reply("250 fake-smtp");
      else if (cmd === "MAIL") reply("250 ok");
      else if (cmd === "RCPT") {
        rcpt.push(/<([^>]*)>/.exec(line)?.[1] ?? "");
        reply("250 ok");
      } else if (cmd === "DATA") {
        data = [];
        reply("354 go ahead");
      } else if (cmd === "QUIT") {
        reply("221 bye");
        sock.end();
      } else if (cmd === "RSET" || cmd === "NOOP") reply("250 ok");
      else reply("502 not implemented");
    }
  });
}).listen(Number(port), "127.0.0.1");
