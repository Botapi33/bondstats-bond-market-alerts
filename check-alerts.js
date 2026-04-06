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

  if (a && (a === label || a === code || a === country || a === name)) return true;

  const aliases = {
    us: ["unitedstates", "usa", "ustreasury"],
    unitedstates: ["us", "usa"],
    uk: ["unitedkingdom", "britain", "greatbritain"],
    unitedkingdom: ["uk", "britain", "greatbritain"],
    jp: ["japan"],
    de: ["germany"],
    fr: ["france"]
  };

  const aliasList = aliases[a] || [];
  return [label, code, country, name].some(v => aliasList.includes(v));
}

async function run() {
  console.log("Starting alert check...");

  const dataRes = await fetch(DATA_URL);
  if (!dataRes.ok) throw new Error(`Data fetch failed: ${dataRes.status}`);

  const json = await dataRes.json();
  const source = json?.data || json?.countries || json || {};
  const markets = Object.values(source).filter(x => x && typeof x === "object");

  console.log("Markets loaded:", markets.length);
  console.log("Sample market:", markets[0]);

  const alertsRes = await supabase
    .from("alerts")
    .select("*")
    .eq("is_active", true);

  if (alertsRes.error) throw alertsRes.error;

  const alerts = alertsRes.data || [];
  console.log("Active alerts loaded:", alerts.length);

  for (const alert of alerts) {
    console.log("Checking alert:", {
      id: alert.id,
      country: alert.country,
      metric: alert.metric,
      operator: alert.operator,
      threshold: alert.threshold
    });

    const market = markets.find(m => countryMatches(alert.country, m));

    if (!market) {
      console.log("No market match for alert country:", alert.country);
      continue;
    }

    console.log("Matched market:", {
      label: market.label,
      code: market.code,
      value: market.value,
      change: market.change
    });

    let metricValue = null;

    if (alert.metric === "yield") {
      metricValue = toNumber(market.value);
    } else if (alert.metric === "move") {
      const rawChange = toNumber(market.change);
      metricValue = rawChange !== null ? rawChange * 100 : null;
    }

    if (metricValue === null) {
      console.log("Metric value is null for alert:", alert.id);
      continue;
    }

    const threshold = Number(alert.threshold);
    const shouldTrigger = passesCondition(metricValue, alert.operator, threshold);
    const cooldownPassed =
      minutesSince(alert.last_triggered_at) >= (alert.cooldown_minutes || 720);

    console.log("Decision:", {
      metricValue,
      threshold,
      shouldTrigger,
      cooldownPassed,
      last_triggered_at: alert.last_triggered_at
    });

    if (!shouldTrigger || !cooldownPassed) continue;

    const updateRes = await supabase
      .from("alerts")
      .update({ last_triggered_at: new Date().toISOString() })
      .eq("id", alert.id);

    if (updateRes.error) throw updateRes.error;

    const eventRes = await supabase
      .from("alert_events")
      .insert({
        alert_id: alert.id,
        user_id: alert.user_id,
        country: alert.country,
        metric: alert.metric,
        operator: alert.operator,
        threshold: alert.threshold,
        current_value: metricValue,
        message: `${alert.country} ${alert.metric} ${alert.operator} ${alert.threshold} triggered at ${metricValue}`
      });

    if (eventRes.error) throw eventRes.error;

    console.log("Triggered alert:", alert.id);
  }

  console.log("Alert check complete");
}

run().catch(err => {
  console.error("Runner failed:", err);
  process.exit(1);
});
async function loadEvents() {
  const email = document.getElementById("lookupEmail").value;

  if (!email) {
    alert("Enter email first");
    return;
  }

  const res = await fetch(API_BASE + "/alerts-events", {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({ email })
  });

  const data = await res.json();

  const container = document.getElementById("eventsList");
  container.innerHTML = "";

  data.events.forEach(e => {
    const div = document.createElement("div");
    div.className = "alert-item";
    div.innerText = `${e.country} triggered at ${e.current_value}`;
    container.appendChild(div);
  });
}
