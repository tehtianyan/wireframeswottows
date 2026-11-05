// Drive a REAL invitation and print the message a participant would receive.
//
// WHY A PROBE AND NOT A TEST. tests/suites/invites.js asserts the properties
// that must hold; this prints the thing a person actually reads, because the
// reported defect was not a broken property — every response was correct — it
// was that the message read as a phishing attempt. No assertion catches that.
// The same argument as tests/peek-ai.mjs, and as looking at the screenshots
// from visual-board: a check phrased against the data cannot see how the
// result lands.
//
// Run it against a local SMTP sink, never a real relay:
//
//   node scratch/smtp-sink.mjs 2525 ./captured.txt
//   SMTP_HOST=127.0.0.1 SMTP_PORT=2525 MAIL_FROM=workshops@example.com \
//     MAIL_FROM_NAME="Consulting OS" go run ./cmd/devserver -env .env.dev -port 3001
//   SWOT_ENV_FILE=.env.dev node tests/peek-invite.mjs http://localhost:3001 ./captured.txt
//
// It invites an @example.invalid address — a domain that cannot receive mail —
// and deletes the account afterwards.
import fs from "node:fs";
import { env, token, client, db, ACCOUNTS, DEMO_WORKSHOP } from "./lib/harness.js";

const baseUrl = process.argv[2] ?? "http://localhost:3001";
const captured = process.argv[3] ?? null;
const probe = `peek-invite-${Date.now()}@example.invalid`;

const e = env();
const c = await db();
const F = client(baseUrl, await token(ACCOUNTS.facilitator));

let userID = null;
try {
  const ws = DEMO_WORKSHOP ?? (await c.query("select id from public.workshops limit 1")).rows[0].id;

  const res = await F("POST", `/workshops/${ws}/participants`, {
    email: probe,
    name: "Sam Rivera",
    role: "participant",
  });
  userID = res.data?.user_id ?? null;

  console.log("=== what the API reported ===");
  console.log(JSON.stringify({ ...res.data, invite_link: res.data?.invite_link ? "(withheld)" : undefined }, null, 2));
  if (res.data?.delivery_notice) console.log("\nNOTICE: " + res.data.delivery_notice);
  if (res.data?.delivery_error) console.log("\nDELIVERY ERROR: " + res.data.delivery_error);

  const log = (
    await c.query(
      `select template_key, subject, status, route, coalesce(error,'') err
         from public.email_deliveries where to_email = $1 order by created_at desc`,
      [probe],
    )
  ).rows;
  console.log("\n=== what the delivery log recorded ===");
  for (const row of log) {
    console.log(`  ${row.status.toUpperCase()} via ${row.route} — ${row.subject}${row.err ? ` — ${row.err}` : ""}`);
  }
  if (log.length === 0) console.log("  (nothing — no send was attempted)");

  if (captured && fs.existsSync(captured)) {
    const raw = fs.readFileSync(captured, "utf8");
    console.log("\n=== headers as sent ===");
    for (const line of raw.split("\n")) {
      if (line.trim() === "") break;
      if (/^(From|To|Reply-To|Subject|Date|Message-ID|Content-Type):/i.test(line)) {
        console.log("  " + line);
      }
    }

    // The two parts come back base64-encoded; decode both so the text can be
    // read and the HTML inspected for anything it should not contain.
    const parts = raw.split(/Content-Transfer-Encoding: base64\n\n/);
    const decode = (p) =>
      Buffer.from(p.split(/\n--/)[0].replace(/\n/g, ""), "base64").toString("utf8");
    if (parts.length > 1) {
      console.log("\n=== the plain-text message, as a recipient reads it ===\n");
      console.log(decode(parts[1]));
    }
    if (parts.length > 2) {
      const html = decode(parts[2]);
      const bad = ["<img", "<script", "<style", "#ZgotmplZ"].filter((x) => html.includes(x));
      console.log("=== the HTML part ===");
      console.log(`  ${html.length} bytes · ${bad.length === 0 ? "no images, scripts or styles" : "CONTAINS " + bad.join(", ")}`);
      const href = html.match(/href="([^"]+)"/);
      console.log(`  link: ${href ? href[1] : "(none — the recipient has no way in)"}`);
    }
  } else if (captured) {
    console.log(`\n(no captured message at ${captured} — was the sink running?)`);
  }
} finally {
  if (userID) {
    await c.query("delete from public.workshop_members where user_id=$1", [userID]).catch(() => {});
    await c.query("delete from public.workspace_members where user_id=$1", [userID]).catch(() => {});
    await c.query("delete from public.profiles where id=$1", [userID]).catch(() => {});
    await fetch(`${e.SUPABASE_URL}/auth/v1/admin/users/${userID}`, {
      method: "DELETE",
      headers: {
        apikey: e.SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${e.SUPABASE_SERVICE_ROLE_KEY}`,
      },
    }).catch(() => {});
  }
  await c.query("delete from public.email_deliveries where to_email like '%@example.invalid'").catch(() => {});
  await c.end().catch(() => {});
}
