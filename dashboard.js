function usedLimit(usage) {
  if (!usage) return "No active subscription";
  const limit = usage.limit === null ? "Unlimited" : Number(usage.limit ?? 0).toLocaleString();
  return `${Number(usage.used ?? 0).toLocaleString()} / ${limit}`;
}

function formatDate(value) {
  return value ? new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(new Date(value)) : "Not active";
}

async function loadDashboard() {
  const response = await fetch("/api/session");
  const session = await response.json();
  if (!session.authenticated) return window.location.assign("/?loginRequired=1");
  const subscription = session.subscription || {};
  document.querySelector("#dashboardEmail").textContent = session.email;
  document.querySelector("#dashboardPlan").textContent = session.planLabel ? `${session.planLabel} plan` : "No subscription";
  document.querySelector("#dashboardVocab").textContent = usedLimit(subscription.usage?.vocabulary);
  document.querySelector("#dashboardSentences").textContent = usedLimit(subscription.usage?.sentence);
  document.querySelector("#dashboardStatusValue").textContent = subscription.status || "Inactive";
  document.querySelector("#dashboardPeriod").textContent = subscription.periodEnd ? `Through ${formatDate(subscription.periodEnd)}` : "Not active";
  const tts = session.ttsUsage || {};
  const usedMinutes = Math.ceil(Number(tts.usedSeconds || 0) / 60);
  const limitMinutes = tts.limitSeconds === null ? "Unlimited" : Math.floor(Number(tts.limitSeconds || 0) / 60);
  document.querySelector("#dashboardTts").textContent = `${usedMinutes} / ${limitMinutes} minutes this ${tts.window || "day"}`;
}

loadDashboard().catch((error) => { document.querySelector("#dashboardStatus").textContent = error.message; });
