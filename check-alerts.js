import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const DATA_URL = "https://botapi33.github.io/bondstats-global-yields/global_yields.json";

function passesCondition(metricValue, operator, threshold) {
  if (operator === "gt") return metricValue > threshold;
  if (operator === "lt") return metricValue < threshold;
  return false;
}

function minutesSince(dateString) {
  if (!dateString) return Infinity;
  return (Date.now() - new Date(dateString).getTime()) / 1000 / 60;
}

async function run() {
  const dataRes = await fetch(DATA_URL);
  if (!dataRes.ok) throw new Error(`Data fetch failed: ${dataRes.status}`);

  const json = await dataRes.json();
  const source = json?.data || {};
  const markets = Object.values(source);

  const alertsRes = await supabase
    .from("alerts")
    .select("*")
    .eq("is_active", true);

  if (alertsRes.error) throw alertsRes.error;

  for (const alert of alertsRes.data) {
    const market = markets.find(m => m.label === alert.country);
    if (!market) continue;

    const metricValue =
      alert.metric === "yield"
        ? Number(market.value)
        : Number(market.change) * 100;

    const shouldTrigger = passesCondition(
      metricValue,
      alert.operator,
      Number(alert.threshold)
    );

    const cooldownPassed =
      minutesSince(alert.last_triggered_at) >= (alert.cooldown_minutes || 720);

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
  }

  console.log("Alert check complete");
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});
