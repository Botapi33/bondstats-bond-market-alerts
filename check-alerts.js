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

function passesCondition(value, operator, threshold) {
  if (operator === "gt") return value > threshold;
  if (operator === "lt") return value < threshold;
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

  const candidates = [
    market?.label,
    market?.code,
    market?.country,
    market?.name,
    market?.iso,
    market?.iso2,
    market?.iso3
  ]
    .filter(Boolean)
    .map(normalize);

  if (candidates.includes(a)) return true;

  const aliases = {
    us: ["unitedstates", "usa"],
    unitedstates: ["us", "usa"],
    usa: ["us", "unitedstates"],
    uk: ["unitedkingdom", "greatbritain", "britain"],
    unitedkingdom: ["uk", "greatbritain", "britain"],
    greatbritain: ["uk", "unitedkingdom"],
    de: ["germany"],
    germany: ["de"],
    fr: ["france"],
    france: ["fr"],
    jp: ["japan"],
    japan: ["jp"]
  };

  const aliasList = aliases[a] || [];
  return candidates.some(c => aliasList.includes(c));
}

function buildEmailHtml(alert, currentValue) {
  return `
    <div style="font-family:Arial,sans-serif;line-height:1.6;color:#111;">
      <h2>BondStats Alert Triggered</h2>
      <p>Your bond alert condition has been met.</p>
      <table cellpadding="8" cellspacing="0" border="0">
        <tr><td><strong>Country</strong></td><td>${alert.country}</td></tr>
        <tr><td><strong>Metric</strong></td><td>${alert.metric}</td></tr>
        <tr><td><strong>Condition</strong></td><td>${alert.operator === "gt" ? ">" : "<"} ${alert.threshold}</td></tr>
        <tr><td><strong>Current Value</strong></td><td>${currentValue}</td></tr>
      </table>
      <p>Open BondStats to review your dashboard and alerts.</p>
    </div>
  `;
}

async function sendMailgunEmail(to, subject, html) {
  const domain = process.env.MAILGUN_DOMAIN;
  const apiKey = process.env.MAILGUN_API_KEY;

  if (!domain || !apiKey) {
    throw new Error("Missing MAILGUN_DOMAIN or MAILGUN_API_KEY");
  }

  const form = new URLSearchParams();
  form.append("from", `BondStats Alerts <alerts@${domain}>`);
  form.append("to", to);
  form.append("subject", subject);
  form.append("html", html);

  const auth = Buffer.from(`api:${apiKey}`).toString("base64");

  const response = await fetch(`https://api.mailgun.net/v3/${domain}/messages`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${auth}`,
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: form
  });

  const text = await response.text();
  console.log("Mailgun response:", text);

  if (!response.ok) {
    throw new Error(`Mailgun error: ${text}`);
  }
}

async function loadMarkets() {
  const dataRes = await fetch(DATA_URL);
  if (!dataRes.ok) {
    throw new Error(`Data fetch failed: ${dataRes.status}`);
  }

  const json = await dataRes.json();
  const source = json?.data || json?.countries || json || {};

  const markets = Object.values(source).filter(
    x => x && typeof x === "object"
  );

  console.log("Markets loaded:", markets.length);
  if (markets.length) {
    console.log("Sample market:", markets[0]);
  }

  return markets;
}

async function loadAlerts() {
  const alertsRes = await supabase
    .from("alerts")
    .select("*, users(email)")
    .eq("is_active", true);

  if (alertsRes.error) throw alertsRes.error;

  const alerts = alertsRes.data || [];
  console.log("Active alerts loaded:", alerts.length);
  return alerts;
}

async function markTriggered(alertId) {
  const updateRes = await supabase
    .from("alerts")
    .update({ last_triggered_at: new Date().toISOString() })
    .eq("id", alertId);

  if (updateRes.error) throw updateRes.error;
}

async function insertEvent(alert, currentValue) {
  const eventRes = await supabase
    .from("alert_events")
    .insert({
      alert_id: alert.id,
      user_id: alert.user_id,
      country: alert.country,
      metric: alert.metric,
      operator: alert.operator,
      threshold: alert.threshold,
      current_value: currentValue,
      message: `${alert.country} ${alert.metric} ${alert.operator} ${alert.threshold} triggered at ${currentValue}`
    });

  if (eventRes.error) throw eventRes.error;
}

async function run() {
  console.log("Starting alert check...");

  const markets = await loadMarkets();
  const alerts = await loadAlerts();

  for (const alert of alerts) {
    console.log("Checking alert:", {
      id: alert.id,
      country: alert.country,
      metric: alert.metric,
      operator: alert.operator,
      threshold: alert.threshold,
      last_triggered_at: alert.last_triggered_at
    });

    const market = markets.find(m => countryMatches(alert.country, m));

    if (!market) {
      console.log("No market match for alert country:", alert.country);
      continue;
    }

    let metricValue = null;

    if (alert.metric === "yield") {
      metricValue = toNumber(market.value);
    } else if (alert.metric === "move") {
      const rawChange = toNumber(market.change);
      metricValue = rawChange !== null ? rawChange * 100 : null;
    } else {
      console.log("Unsupported metric:", alert.metric);
      continue;
    }

    if (metricValue === null) {
      console.log("Metric value invalid for alert:", alert.id, "market:", market);
      continue;
    }

    const threshold = Number(alert.threshold);
    const shouldTrigger = passesCondition(metricValue, alert.operator, threshold);
    const cooldownMinutes = Number(alert.cooldown_minutes || 720);
    const cooldownPassed = minutesSince(alert.last_triggered_at) >= cooldownMinutes;

    console.log("Decision:", {
      metricValue,
      threshold,
      shouldTrigger,
      cooldownPassed
    });

    if (!shouldTrigger || !cooldownPassed) continue;

    console.log("🚨 TRIGGER:", alert.id);

    await markTriggered(alert.id);
    await insertEvent(alert, metricValue);

    const email = alert.users?.email;
    if (!email) {
      console.log("No email found for alert:", alert.id);
      continue;
    }

    try {
      await sendMailgunEmail(
        email,
        `BondStats Alert: ${alert.country} ${alert.metric} triggered`,
        buildEmailHtml(alert, metricValue)
      );
      console.log("Email sent for alert", alert.id, "to", email);
    } catch (emailError) {
      console.error("Email send failed for alert", alert.id, emailError);
    }
  }

  console.log("Alert check complete");
}

run().catch(err => {
  console.error("Runner failed:", err);
  process.exit(1);
});
