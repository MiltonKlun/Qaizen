// ---- Bench Shop behavior, shared by every served version (task group
// 9.2). What differs between versions (hook names, two class names, the
// overview markup) lives in versions.js; everything here is identical
// across versions, so a bug added here reaches all of them.
const VERSION = window.__BENCH__.version;
const V = window.BENCH_VERSIONS[VERSION];
document.title = `Bench Shop (${VERSION})`;

// ---- Bench Shop: a minimal, self-contained shop that mirrors the
// SauceDemo surfaces our benchmark stories exercise (login, inventory
// with add/remove + cart badge, cart, two-step checkout with Item total /
// Tax / Total). Vanilla JS, no framework, no build. data-test attributes
// mirror SauceDemo naming so existing test styles transfer.
//
// Bug switches (window.__BENCH__.bugs) mutate behavior at RUNTIME — there
// is one app, never a buggy copy:
//   stale-badge        cart badge does not decrement on remove until a
//                      reload (STORY-003's documented bug)
//   wrong-item-total   overview item total = sum of prices + 1.00
//                      (STORY-020 RISK-001)
//   inconsistent-total overview total != item total + tax
//                      (STORY-020 RISK-002)
const BUGS = new Set(window.__BENCH__.bugs || []);
const has = (b) => BUGS.has(b);

const TAX_RATE = 0.08; // 8% — an app constant, read live by good tests
const PRODUCTS = [
  {
    id: 'sauce-labs-backpack',
    name: 'Sauce Labs Backpack',
    price: 29.99,
  },
  {
    id: 'sauce-labs-bike-light',
    name: 'Sauce Labs Bike Light',
    price: 9.99,
  },
  {
    id: 'sauce-labs-bolt-t-shirt',
    name: 'Sauce Labs Bolt T-Shirt',
    price: 15.99,
  },
];
const money = (n) => `$${n.toFixed(2)}`;
const app = document.getElementById('app');

const state = {
  user: null,
  cart: [], // product ids
  // badgeCount is what the badge SHOWS; with stale-badge it diverges from
  // cart.length on remove until a reload re-syncs it.
  badgeCount: 0,
  checkout: { firstName: '', lastName: '', postalCode: '' },
};

function renderBadge() {
  const badge = document.querySelector('[data-test="shopping-cart-badge"]');
  const n = has('stale-badge') ? state.badgeCount : state.cart.length;
  if (n > 0) {
    badge.textContent = String(n);
    badge.classList.remove('hidden');
  } else {
    badge.textContent = '';
    badge.classList.add('hidden');
  }
}

// Navigate. Setting the hash fires `hashchange`, which is what renders —
// calling render() here too would render TWICE and re-create the DOM,
// wiping input the user had already typed. Only render directly when the
// hash is already at the target, since that fires no `hashchange`.
function go(route) {
  if (location.hash === route) render();
  else location.hash = route;
}

// ---- views -----------------------------------------------------------
function loginView() {
  app.innerHTML = `
          <h1 class="${V.titleClass}" data-test="title">Login</h1>
          <input data-test="${V.hooks.username}" placeholder="Username" />
          <input data-test="${V.hooks.password}" type="password" placeholder="Password" />
          <button class="primary" data-test="login-button">Login</button>
          <p class="error" data-test="error"></p>
        `;
  app.querySelector('[data-test="login-button"]').onclick = () => {
    const u = app
      .querySelector(`[data-test="${V.hooks.username}"]`)
      .value.trim();
    const p = app.querySelector(`[data-test="${V.hooks.password}"]`).value;
    if (u === 'standard_user' && p === 'secret_sauce') {
      state.user = u;
      go('#inventory');
    } else {
      app.querySelector('[data-test="error"]').textContent =
        'Username and password do not match any user in this service';
    }
  };
}

function inventoryView() {
  app.innerHTML = `
          <h1 class="${V.titleClass}" data-test="title">Products</h1>
          <div id="list"></div>
        `;
  const list = app.querySelector('#list');
  for (const prod of PRODUCTS) {
    const inCart = state.cart.includes(prod.id);
    const row = document.createElement('div');
    row.className = 'item';
    row.innerHTML = `
            <span>
              <span class="item_name" data-test="inventory-item-name">${prod.name}</span>
            </span>
            <span>
              <span class="${V.priceClass}" data-test="${V.hooks.price}">${money(prod.price)}</span>
              <button data-test="${inCart ? 'remove' : V.hooks.add}-${prod.id}">
                ${inCart ? 'Remove' : 'Add to cart'}
              </button>
            </span>
          `;
    row.querySelector('button').onclick = () => {
      if (inCart) removeFromCart(prod.id);
      else addToCart(prod.id);
      inventoryView();
    };
    list.appendChild(row);
  }
}

function cartView() {
  const rows = state.cart
    .map((id) => {
      const p = PRODUCTS.find((x) => x.id === id);
      return `
              <div class="cart_item item">
                <span class="item_name" data-test="inventory-item-name">${p.name}</span>
                <span class="${V.priceClass}" data-test="${V.hooks.price}">${money(p.price)}</span>
                <button data-test="remove-${p.id}">Remove</button>
              </div>`;
    })
    .join('');
  app.innerHTML = `
          <h1 class="${V.titleClass}" data-test="title">Your Cart</h1>
          <div id="cartlist">${rows || '<p>Cart is empty.</p>'}</div>
          <button data-test="continue-shopping" onclick="location.hash='#inventory'">Continue Shopping</button>
          <button class="primary" data-test="checkout" ${state.cart.length ? '' : 'disabled'}>Checkout</button>
        `;
  app.querySelectorAll('[data-test^="remove-"]').forEach((btn) => {
    btn.onclick = () => {
      const id = btn.getAttribute('data-test').replace('remove-', '');
      removeFromCart(id);
      cartView();
    };
  });
  const co = app.querySelector('[data-test="checkout"]');
  if (co) co.onclick = () => go('#checkout-step-one');
}

function checkoutStepOneView() {
  app.innerHTML = `
          <h1 class="${V.titleClass}" data-test="title">Checkout: Your Information</h1>
          <input data-test="firstName" placeholder="First Name" />
          <input data-test="lastName" placeholder="Last Name" />
          <input data-test="postalCode" placeholder="Zip/Postal Code" />
          <p class="error" data-test="error"></p>
          <button data-test="cancel" onclick="location.hash='#cart'">Cancel</button>
          <button class="primary" data-test="continue">Continue</button>
        `;
  app.querySelector('[data-test="continue"]').onclick = () => {
    const fn = app.querySelector('[data-test="firstName"]').value.trim();
    const ln = app.querySelector('[data-test="lastName"]').value.trim();
    const zip = app.querySelector('[data-test="postalCode"]').value.trim();
    if (!fn || !ln || !zip) {
      app.querySelector('[data-test="error"]').textContent =
        'Error: First Name, Last Name and Postal Code are required';
      return;
    }
    state.checkout = { firstName: fn, lastName: ln, postalCode: zip };
    go('#checkout-step-two');
  };
}

function overviewView() {
  // The money-math a good test reads LIVE. All figures are derived here
  // from PRODUCTS, so a correct test asserts relationships (total ===
  // itemTotal + tax), not memorized constants.
  const prices = state.cart.map(
    (id) => PRODUCTS.find((x) => x.id === id).price
  );
  const trueSum = prices.reduce((a, b) => a + b, 0);
  const itemTotal = has('wrong-item-total') ? trueSum + 1.0 : trueSum;
  const tax = Math.round(trueSum * TAX_RATE * 100) / 100;
  const total = has('inconsistent-total')
    ? itemTotal + tax + 0.5
    : itemTotal + tax;

  const lines = state.cart
    .map((id) => {
      const p = PRODUCTS.find((x) => x.id === id);
      return `
              <div class="cart_item item">
                <span class="item_name" data-test="inventory-item-name">${p.name}</span>
                <span class="${V.priceClass}" data-test="${V.hooks.price}">${money(p.price)}</span>
              </div>`;
    })
    .join('');
  app.innerHTML = `
          <h1 class="${V.titleClass}" data-test="title">Checkout: Overview</h1>
          ${V.overview(lines)}
          ${V.summary(money(itemTotal), money(tax), money(total))}
          <button data-test="cancel" onclick="location.hash='#inventory'">Cancel</button>
          <button class="primary" data-test="finish">Finish</button>
        `;
  app.querySelector('[data-test="finish"]').onclick = () =>
    go('#checkout-complete');
}

function completeView() {
  app.innerHTML = `
          <h1 class="${V.titleClass}" data-test="title">Checkout: Complete!</h1>
          <h2 class="complete-header" data-test="complete-header">Thank you for your order!</h2>
          <p>Your order has been dispatched.</p>
          <button class="primary" data-test="back-to-products" onclick="location.hash='#inventory'">Back Home</button>
        `;
  // A finished order empties the cart.
  state.cart = [];
  state.badgeCount = 0;
  renderBadge();
}

// ---- cart ops --------------------------------------------------------
function addToCart(id) {
  if (!state.cart.includes(id)) {
    state.cart.push(id);
    state.badgeCount = state.cart.length;
  }
  renderBadge();
}
function removeFromCart(id) {
  state.cart = state.cart.filter((x) => x !== id);
  // The bug: badgeCount does NOT follow cart.length on remove, so the
  // shown badge is stale until a reload re-syncs badgeCount below.
  if (!has('stale-badge')) state.badgeCount = state.cart.length;
  renderBadge();
}

// ---- router ----------------------------------------------------------
function render() {
  // On a full load/reload, badgeCount re-syncs to the real cart — which
  // is exactly why stale-badge "self-heals" on reload.
  state.badgeCount = state.cart.length;
  const route = location.hash || '#login';
  if (!state.user && route !== '#login') return go('#login');
  if (route === '#login') loginView();
  else if (route === '#inventory') inventoryView();
  else if (route === '#cart') cartView();
  else if (route === '#checkout-step-one') checkoutStepOneView();
  else if (route === '#checkout-step-two') overviewView();
  else if (route === '#checkout-complete') completeView();
  else inventoryView();
  renderBadge();
}

window.addEventListener('hashchange', render);
render();
