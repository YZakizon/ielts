const adminStatus = document.querySelector("#adminStatus");
const adminUsersList = document.querySelector("#adminUsersList");
const adminConfirmDialog = document.querySelector("#adminConfirmDialog");
const adminConfirmTitle = document.querySelector("#adminConfirmTitle");
const adminConfirmMessage = document.querySelector("#adminConfirmMessage");
const adminConfirmSubmit = document.querySelector("#adminConfirmSubmit");
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

function moreIcon() {
  return `<svg aria-hidden="true" viewBox="0 0 24 24"><circle cx="12" cy="5" r="1" /><circle cx="12" cy="12" r="1" /><circle cx="12" cy="19" r="1" /></svg>`;
}

function confirmAdminAction(title, message) {
  adminConfirmTitle.textContent = title;
  adminConfirmMessage.textContent = message;
  adminConfirmSubmit.textContent = title;
  adminConfirmDialog.returnValue = "";
  adminConfirmDialog.showModal();
  return new Promise((resolve) => adminConfirmDialog.addEventListener("close", () => resolve(adminConfirmDialog.returnValue === "confirm"), { once: true }));
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

function formatUsageValue(used, limit) {
  return `${Number(used || 0).toLocaleString()} / ${limit === null ? "Unlimited" : Number(limit).toLocaleString()}`;
}

function renderUsage(user) {
  const usage = user.usage || {};
  const requests = usage.requestLimits;
  const requestLine = requests
    ? `<span><b>Requests</b> ${escapeHtml(requests.minute?.used || 0)}/${escapeHtml(
        requests.minute?.limit || 0,
      )} min · ${escapeHtml(requests.hour?.used || 0)}/${escapeHtml(requests.hour?.limit || 0)} hr · ${escapeHtml(
        requests.day?.used || 0,
      )}/${escapeHtml(requests.day?.limit || 0)} day</span>`
    : `<span><b>Requests</b> No rate limit</span>`;

  return `
    <div class="admin-usage" aria-label="Current usage and limits for ${escapeHtml(user.email)}">
      ${requestLine}
      <span><b>Vocabulary</b> ${escapeHtml(formatUsageValue(usage.vocabUsedToday, usage.vocabDailyLimit))} today</span>
      <span><b>Translations</b> ${escapeHtml(
        formatUsageValue(usage.translationUsedToday, usage.translationDailyLimit),
      )} today</span>
    </div>
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
          ${renderUsage(user)}
          <span>${escapeHtml(billingStatusLabel(user))}</span>
          <span>${escapeHtml(formatDate(user.createdAt))}</span>
          <div class="admin-row-menu-root">
            <button class="icon-button" type="button" data-user-menu-toggle aria-label="Actions for ${escapeHtml(user.email)}" aria-haspopup="menu" aria-expanded="false">${moreIcon()}</button>
            <div class="admin-row-menu hidden" role="menu">
              <button type="button" data-adjust-usage="vocabulary_translation" role="menuitem">Adjust vocabulary</button>
              <button type="button" data-adjust-usage="sentence_translation" role="menuitem">Adjust sentence</button>
              <button type="button" data-view-usage role="menuitem">View history</button>
              <button class="danger-menu-item" type="button" data-delete-user-id="${escapeHtml(user.id)}" role="menuitem">${deleteIcon()} Delete user</button>
            </div>
          </div>
          <div class="admin-usage-history" data-usage-history></div>
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
  if (!(await confirmAdminAction("Delete user", `Delete ${email}? This permanently removes the local account and cannot be undone.`))) {
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
  const toggle = event.target.closest("[data-user-menu-toggle]");
  if (toggle) {
    const menu = toggle.nextElementSibling;
    const open = menu.classList.contains("hidden");
    document.querySelectorAll(".admin-row-menu").forEach((item) => item.classList.add("hidden"));
    menu.classList.toggle("hidden", !open);
    toggle.setAttribute("aria-expanded", String(open));
    return;
  }
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

adminConfirmDialog.addEventListener("click", (event) => { if (event.target === adminConfirmDialog) adminConfirmDialog.close("cancel"); });
document.addEventListener("click", (event) => {
  if (event.target.closest(".admin-row-menu-root")) return;
  document.querySelectorAll(".admin-row-menu").forEach((menu) => menu.classList.add("hidden"));
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
