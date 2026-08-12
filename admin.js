const adminStatus = document.querySelector("#adminStatus");
const adminUsersList = document.querySelector("#adminUsersList");
const accountPlanOptions = [
  { value: "free", label: "Free" },
  { value: "premium", label: "Premium" },
  { value: "ultimate", label: "Ultimate" },
  { value: "admin", label: "Admin" },
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
  const localPlan = String(user.localPlan || user.plan || "free").toLowerCase();
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
      <span class="admin-plan">${escapeHtml(user.planLabel || user.plan || "Free")}</span>
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
  const previousPlan = select.dataset.currentPlan || "free";
  select.disabled = true;
  adminStatus.textContent = "Updating plan...";

  try {
    const response = await fetch(`/api/admin/users/${encodeURIComponent(userId)}/plan`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ plan }),
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

adminUsersList.addEventListener("click", (event) => {
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
