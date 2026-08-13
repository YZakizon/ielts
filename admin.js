const adminStatus = document.querySelector("#adminStatus");
const adminUsersList = document.querySelector("#adminUsersList");
const accountPlanOptions = [
  { value: "none", label: "No subscription" },
  { value: "premium", label: "Premium" },
  { value: "pro", label: "Pro" },
];

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function formatDate(value) {
  if (!value) return "Unknown";
  return new Intl.DateTimeFormat(undefined, {
    day: "2-digit",
    month: "short",
    year: "numeric",
  }).format(new Date(value));
}

function billingStatusLabel(user) {
  if (user.billingStatus === "stripe_not_configured") return "Stripe not configured";
  if (user.billingStatus === "lookup_error") return "Billing lookup error";
  if (user.isAdmin) return "Admin";
  if (!user.emailVerified) return "Unverified";
  return user.billingStatus || "Active";
}

function deleteIcon() {
  return `
    <svg aria-hidden="true" viewBox="0 0 24 24">
      <path d="M3 6h18" />
      <path d="M8 6V4h8v2" />
      <path d="M19 6l-1 14H6L5 6" />
      <path d="M10 11v5" />
      <path d="M14 11v5" />
    </svg>
  `;
}

function renderPlanSelect(user) {
  const localPlan = String(user.subscription?.plan || "none").toLowerCase();
  const options = accountPlanOptions
    .map(
      (plan) =>
        `<option value="${escapeHtml(plan.value)}"${plan.value === localPlan ? " selected" : ""}>${escapeHtml(
          plan.label,
        )}</option>`,
    )
    .join("");

  return `
    <label class="admin-plan-control">
      <span class="admin-plan">${escapeHtml(user.planLabel || "No subscription")}</span>
      <select data-plan-user-id="${escapeHtml(user.id)}" data-current-plan="${escapeHtml(localPlan)}" aria-label="Set plan for ${escapeHtml(
        user.email,
      )}">
        ${options}
      </select>
    </label>
  `;
}

function renderUsers(users) {
  if (!users.length) {
    adminUsersList.innerHTML = `<p class="history-empty">No users found.</p>`;
    return;
  }

  adminUsersList.innerHTML = users
    .map(
      (user) => `
        <article class="admin-user-row" data-user-id="${escapeHtml(user.id)}">
          <div>
            <strong>${escapeHtml(user.email)}</strong>
            <small>${user.isAdmin ? "Admin user" : user.emailVerified ? "Verified" : "Email not verified"}</small>
          </div>
          ${renderPlanSelect(user)}
          <span>${escapeHtml(billingStatusLabel(user))}</span>
          <span>${escapeHtml(formatDate(user.createdAt))}</span>
          <button class="icon-button danger-icon-button" type="button" data-delete-user-id="${escapeHtml(
            user.id,
          )}" aria-label="Delete ${escapeHtml(user.email)}">
            ${deleteIcon()}
          </button>
          <details class="admin-subscription-details">
            <summary>Subscription details</summary>
            <div><span>Source</span><strong>${escapeHtml(user.subscription?.source || "None")}</strong></div>
            <div><span>Expires</span><strong>${escapeHtml(user.subscription?.expiresAt ? formatDate(user.subscription.expiresAt) : "Never")}</strong></div>
            <div><span>Vocabulary</span><strong>${user.subscription?.usage ? `${user.subscription.usage.vocabulary.used} / ${user.subscription.usage.vocabulary.limit}` : "Locked"}</strong></div>
            <div><span>Sentence</span><strong>${user.subscription?.usage ? `${user.subscription.usage.sentence.used} / ${user.subscription.usage.sentence.limit}` : "Locked"}</strong></div>
            <div class="admin-usage-actions">
              <button type="button" class="ghost-button" data-adjust-usage="vocabulary_translation">Adjust vocabulary</button>
              <button type="button" class="ghost-button" data-adjust-usage="sentence_translation">Adjust sentence</button>
              <button type="button" class="ghost-button" data-view-usage>View history</button>
            </div>
            <div class="admin-usage-history" data-usage-history></div>
          </details>
        </article>
      `,
    )
    .join("");
}

async function responseErrorMessage(response, fallback) {
  const data = await response.clone().json().catch(() => null);
  return data?.error || (await response.text().catch(() => "")) || fallback;
}

async function loadUsers() {
  adminStatus.textContent = "Loading users...";
  const response = await fetch("/api/admin/users");
  if (response.status === 401) {
    window.location.href = "/";
    return;
  }
  if (!response.ok) {
    throw new Error(await responseErrorMessage(response, "Could not load users."));
  }

  const data = await response.json();
  renderUsers(data.users || []);
  adminStatus.textContent = data.stripeConfigured
    ? `${data.users?.length || 0} users`
    : `${data.users?.length || 0} users · Stripe not configured`;
}

async function updateUserPlan(userId, plan, select) {
  const previousPlan = select.dataset.currentPlan || "none";
  select.disabled = true;
  adminStatus.textContent = "Updating plan...";

  try {
    const reason = window.prompt(plan === "none" ? "Reason for removing access" : "Reason for granting this subscription");
    if (reason === null || !reason.trim()) throw new Error("A reason is required.");
    const expiration = plan === "none" ? "" : window.prompt("Expiration date (YYYY-MM-DD), or leave blank for permanent access", "");
    if (expiration === null) throw new Error("Subscription update cancelled.");
    const response = await fetch(`/api/admin/users/${encodeURIComponent(userId)}/subscription`, {
      method: plan === "none" ? "DELETE" : previousPlan === "none" ? "POST" : "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ plan, reason, expiresAt: expiration ? `${expiration}T23:59:59Z` : null }),
    });
    if (!response.ok) {
      throw new Error(await responseErrorMessage(response, "Could not update plan."));
    }
    await loadUsers();
  } catch (error) {
    select.value = previousPlan;
    select.disabled = false;
    adminStatus.textContent = error.message;
  }
}

async function deleteUser(userId, email) {
  if (!window.confirm(`Delete ${email}? This permanently removes the local account.`)) {
    return;
  }

  const button = adminUsersList.querySelector(`[data-delete-user-id="${String(userId)}"]`);
  if (button) button.disabled = true;

  try {
    const response = await fetch(`/api/admin/users/${encodeURIComponent(userId)}`, {
      method: "DELETE",
    });
    if (!response.ok) {
      throw new Error(await responseErrorMessage(response, "Could not delete user."));
    }
    await loadUsers();
  } catch (error) {
    adminStatus.textContent = error.message;
    if (button) button.disabled = false;
  }
}

async function adjustUsage(row, type) {
  const amount = Number(window.prompt("Adjustment amount (positive adds usage, negative refunds usage)", "0"));
  if (!Number.isSafeInteger(amount) || amount === 0) return;
  const reason = window.prompt("Reason for this usage adjustment");
  if (!reason?.trim()) return;
  const response = await fetch(`/api/admin/users/${encodeURIComponent(row.dataset.userId)}/usage-adjustment`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ type, amount, reason }),
  });
  if (!response.ok) throw new Error(await responseErrorMessage(response, "Could not adjust usage."));
  await loadUsers();
}

async function viewUsageHistory(row) {
  const output = row.querySelector("[data-usage-history]");
  output.textContent = "Loading history...";
  const response = await fetch(`/api/admin/users/${encodeURIComponent(row.dataset.userId)}/usage`);
  if (!response.ok) throw new Error(await responseErrorMessage(response, "Could not load usage history."));
  const periods = (await response.json()).periods || [];
  output.innerHTML = periods.length ? periods.map((period) => `<div><span>${escapeHtml(formatDate(period.period_start))} - ${escapeHtml(formatDate(period.period_end))}</span><strong>Vocabulary ${Number(period.vocabulary_used)} / ${Number(period.vocabulary_limit)}; Sentence ${Number(period.sentence_used)} / ${Number(period.sentence_limit)}</strong></div>`).join("") : "No usage periods yet.";
}

adminUsersList.addEventListener("click", (event) => {
  const adjust = event.target.closest("[data-adjust-usage]");
  const history = event.target.closest("[data-view-usage]");
  const actionRow = event.target.closest(".admin-user-row");
  if (adjust && actionRow) {
    adjustUsage(actionRow, adjust.dataset.adjustUsage).catch((error) => { adminStatus.textContent = error.message; });
    return;
  }
  if (history && actionRow) {
    viewUsageHistory(actionRow).catch((error) => { adminStatus.textContent = error.message; });
    return;
  }
  const button = event.target.closest("[data-delete-user-id]");
  if (!button) return;

  const row = button.closest(".admin-user-row");
  const email = row?.querySelector("strong")?.textContent || "this user";
  deleteUser(button.dataset.deleteUserId, email);
});

adminUsersList.addEventListener("change", (event) => {
  const select = event.target.closest("[data-plan-user-id]");
  if (!select) return;
  updateUserPlan(select.dataset.planUserId, select.value, select);
});

loadUsers().catch((error) => {
  adminUsersList.innerHTML = "";
  adminStatus.textContent = error.message;
});
