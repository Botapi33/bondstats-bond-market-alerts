import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const DATA_URL = "https://botapi33.github.io/bondstats-global-yields/global_yields.json";

function normalize(str) {
  return String(str || "")
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/[^a-z0-9]/g, "");
}

function passesCondition(metricValue, operator, threshold) {
  if (operator === "gt") return metricValue > threshold;
  if (operator === "lt") return metricValue < threshold;
  return false;
}

function minutesSince(dateString) {
  if (!dateString) return Infinity;
  return (Date.now() - new Date(dateString).getTime()) / 1000 / 60;
}

function toNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function countryMatches(alertCountry, market) {
  const a = normalize(alertCountry);
  const label = normalize(market.label);
  const code = normalize(market.code);
  const country = normalize(market.country);
  const name = normalize(market.name);

  return a === label || a === code || a === country || a === name;
}

function buildEmailHtml({ country, metric, operator, threshold, currentValue }) {
  return `
    <h2>BondStats Alert</h2>
    <p><strong>${country}</strong></p>
    <p>${metric} ${operator} ${threshold}</p>
    <p>Current value: ${currentValue}</p>
  `;
}

async function sendMailgunEmail(to, subject, html) {
  const domain = process.env.MAILGUN_DOMAIN;
  const apiKey = process.env.MAILGUN_API_KEY;

  const form = new URLSearchParams();
  form.append("from", `BondStats Alerts <alerts@${domain}>`);
  form.append("to", to);
  form.append("subject", subject);
  form.append("html", html);

  const auth = Buffer.from(`api:${apiKey}`).toString("base64");

  const res = await fetch(`https://api.mailgun.net/v3/${domain}/messages`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${auth}`,
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: form
  });

  const text = await res.text();
  console.log("Mailgun:", text);
}

async function run() {
  console.log("Starting alert check...");

  const dataRes = await fetch(DATA_URL);
  const json = await dataRes.json();
  const markets = Object.values(json);

  const { data: alerts } = await supabase
    .from("alerts")
    .select("*, users(email)")
    .eq("is_active", true);

  for (const alert of alerts) {
    const market = markets.find(m => countryMatches(alert.country, m));
    if (!market) continue;

    const metricValue = toNumber(market.value);
    if (metricValue === null) continue;

    const shouldTrigger = passesCondition(
      metricValue,
      alert.operator,
      Number(alert.threshold)
    );

    const cooldownPassed =
      minutesSince(alert.last_triggered_at) >= alert.cooldown_minutes;

    if (!shouldTrigger || !cooldownPassed) continue;

    console.log("🚨 TRIGGER:", alert.id);

    // Update DB
    await supabase
      .from("alerts")
      .update({ last_triggered_at: new Date().toISOString() })
      .eq("id", alert.id);

    // Insert event
    await supabase.from("alert_events").insert({
      alert_id: alert.id,
      user_id: alert.user_id,
      message: "Triggered"
    });

    const email = alert.users?.email;
    if (!email) continue;

    await sendMailgunEmail(
      email,
      `Bond Alert: ${alert.country}`,
      buildEmailHtml({
        country: alert.country,
        metric: alert.metric,
        operator: alert.operator,
        threshold: alert.threshold,
        currentValue: metricValue
      })
    );
  }

  console.log("Done");
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});
