// ---- Bench Shop behavior, shared by every served version. What differs
// between versions (hook names, two class names, the order-review markup)
// lives in versions.js; everything here is identical across versions, so a
// bug added here reaches all of them.
//
// Bench Shop is a small workshop-tools store: sign in, a catalogue with
// add/take-out and a basket count, the basket, delivery details, an order
// review (Items / Sales tax / Order total) and a confirmation. Its products,
// prices, tax rule, credentials, routes, text and `data-qa` hooks are its
// own, chosen so that nothing about it can be recalled from a well-known
// public demo shop: a test that works here was written by looking at it.
//
// Bug switches (window.__BENCH__.bugs) change behavior at RUNTIME; there is
// one app, never a buggy copy:
//   stale-badge        the basket count does not go down on a take-out until
//                      the next change of screen (BENCH-1, RISK-001)
//   wrong-item-total   the review's Items figure = sum of prices + 1.00
//                      (BENCH-2, RISK-001)
//   inconsistent-total the Order total != Items + Sales tax, by 0.50
//                      (BENCH-2, RISK-002)
const VERSION = window.__BENCH__.version;
const V = window.BENCH_VERSIONS[VERSION];
document.title = `Bench Shop (${VERSION})`;

const BUGS = new Set(window.__BENCH__.bugs || []);
const has = (b) => BUGS.has(b);

// Sales tax: 6.5% of the items, rounded half up to the cent. An app rule, read
// from the review screen by a good test, never assumed.
const TAX_BASIS_POINTS = 650;
// Prices in cents, so the money math is exact.
const PRODUCTS = [
  { id: 'chisel-set', name: 'Bevel-Edge Chisel Set', cents: 3450 },
  { id: 'marking-gauge', name: 'Brass Marking Gauge', cents: 1225 },
  { id: 'block-plane', name: 'Low-Angle Block Plane', cents: 5875 },
];
const USER = { name: 'ada.joiner', secret: 'dovetail-42' };

const money = (cents) =>
  `$${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, '0')}`;
const taxOf = (cents) => Math.floor((cents * TAX_BASIS_POINTS + 5000) / 10000);
const app = document.getElementById('app');
const qa = (root, hook) => root.querySelector(`[data-qa="${hook}"]`);

const state = {
  user: null,
  basket: [], // product ids
  // shownCount is what the basket count SHOWS; with stale-badge it lags
  // behind basket.length on a take-out until the next change of screen
  // re-syncs it.
  shownCount: 0,
  delivery: { givenName: '', familyName: '', postcode: '' },
  // Set by "Place order": the confirmation is reached only that way.
  placing: false,
};

function renderCount() {
  const count = qa(document, 'basket-count');
  const n = has('stale-badge') ? state.shownCount : state.basket.length;
  if (n > 0) {
    count.textContent = String(n);
    count.classList.remove('hidden');
  } else {
    count.textContent = '';
    count.classList.add('hidden');
  }
}

// Navigate. Setting the hash fires `hashchange`, which is what renders;
// rendering here too would render TWICE and wipe what the user had typed.
// Only render directly when the hash is already at the target.
function go(route) {
  if (location.hash === route) render();
  else location.hash = route;
}

const heading = (text) =>
  `<h1 class="${V.headingClass}" data-qa="page-heading">${text}</h1>`;

// ---- views -----------------------------------------------------------
function signinView() {
  app.innerHTML = `
          ${heading('Sign in to Bench Shop')}
          <label>Workshop ID <input data-qa="${V.hooks.user}" autocomplete="off" /></label>
          <label>Passphrase <input data-qa="${V.hooks.pass}" type="password" /></label>
          <button class="primary" data-qa="login-submit">Sign in</button>
          <p class="notice" data-qa="form-error"></p>
          <p class="hint" data-qa="demo-account">Demo workshop: ID <code>${USER.name}</code>, passphrase <code>${USER.secret}</code>.</p>
        `;
  qa(app, 'login-submit').onclick = () => {
    const u = qa(app, V.hooks.user).value.trim();
    const p = qa(app, V.hooks.pass).value;
    if (u === USER.name && p === USER.secret) {
      state.user = u;
      go('#catalogue');
    } else {
      qa(app, 'form-error').textContent =
        'That workshop ID and passphrase do not match.';
    }
  };
}

function catalogueView() {
  app.innerHTML = `
          ${heading('Workshop catalogue')}
          <div id="shelf"></div>
        `;
  const shelf = app.querySelector('#shelf');
  for (const prod of PRODUCTS) {
    const inBasket = state.basket.includes(prod.id);
    const row = document.createElement('div');
    row.className = 'product';
    row.innerHTML = `
            <span class="product-name" data-qa="product-name">${prod.name}</span>
            <span>
              <span class="${V.priceClass}" data-qa="${V.hooks.price}">${money(prod.cents)}</span>
              <button data-qa="${inBasket ? 'basket-remove' : V.hooks.add}-${prod.id}">
                ${inBasket ? 'Take out' : 'Add to basket'}
              </button>
            </span>
          `;
    row.querySelector('button').onclick = () => {
      if (inBasket) takeOut(prod.id);
      else putIn(prod.id);
      catalogueView();
    };
    shelf.appendChild(row);
  }
}

function basketView() {
  const rows = state.basket
    .map((id) => {
      const p = PRODUCTS.find((x) => x.id === id);
      return `
              <div class="product basket-line">
                <span class="product-name" data-qa="product-name">${p.name}</span>
                <span class="${V.priceClass}" data-qa="${V.hooks.price}">${money(p.cents)}</span>
                <button data-qa="basket-remove-${p.id}">Take out</button>
              </div>`;
    })
    .join('');
  app.innerHTML = `
          ${heading('Your basket')}
          <div id="basket-lines">${rows || '<p>Your basket is empty.</p>'}</div>
          <button data-qa="keep-shopping" onclick="location.hash='#catalogue'">Keep shopping</button>
          <button class="primary" data-qa="go-to-checkout" ${state.basket.length ? '' : 'disabled'}>Go to checkout</button>
        `;
  app.querySelectorAll('[data-qa^="basket-remove-"]').forEach((btn) => {
    btn.onclick = () => {
      takeOut(btn.getAttribute('data-qa').replace('basket-remove-', ''));
      basketView();
    };
  });
  const next = qa(app, 'go-to-checkout');
  if (next) next.onclick = () => go('#details');
}

function detailsView() {
  app.innerHTML = `
          ${heading('Delivery details')}
          <label>Given name <input data-qa="given-name" /></label>
          <label>Family name <input data-qa="family-name" /></label>
          <label>Postcode <input data-qa="postcode" /></label>
          <p class="notice" data-qa="form-error"></p>
          <button data-qa="back-to-basket" onclick="location.hash='#basket'">Back to basket</button>
          <button class="primary" data-qa="review-order">Review order</button>
        `;
  qa(app, 'review-order').onclick = () => {
    const given = qa(app, 'given-name').value.trim();
    const family = qa(app, 'family-name').value.trim();
    const postcode = qa(app, 'postcode').value.trim();
    const missing = [
      [given, 'a given name'],
      [family, 'a family name'],
      [postcode, 'a postcode'],
    ]
      .filter(([v]) => !v)
      .map(([, what]) => what);
    if (missing.length) {
      const list =
        missing.length > 1
          ? `${missing.slice(0, -1).join(', ')} and ${missing.at(-1)}`
          : missing[0];
      qa(app, 'form-error').textContent = `Please enter ${list}.`;
      return;
    }
    state.delivery = { givenName: given, familyName: family, postcode };
    go('#review');
  };
}

function reviewView() {
  // The money math a good test reads LIVE. Every figure is derived here from
  // PRODUCTS, so a correct test asserts relationships (order total = items +
  // sales tax), not remembered constants.
  const trueItems = state.basket
    .map((id) => PRODUCTS.find((x) => x.id === id).cents)
    .reduce((a, b) => a + b, 0);
  const items = has('wrong-item-total') ? trueItems + 100 : trueItems;
  const tax = taxOf(trueItems);
  const total = has('inconsistent-total') ? items + tax + 50 : items + tax;

  const lines = state.basket
    .map((id) => {
      const p = PRODUCTS.find((x) => x.id === id);
      return `
              <div class="product basket-line">
                <span class="product-name" data-qa="product-name">${p.name}</span>
                <span class="${V.priceClass}" data-qa="${V.hooks.price}">${money(p.cents)}</span>
              </div>`;
    })
    .join('');
  app.innerHTML = `
          ${heading('Review your order')}
          ${V.review(lines)}
          ${V.summary(money(items), money(tax), money(total))}
          <button data-qa="cancel-order" onclick="location.hash='#catalogue'">Cancel</button>
          <button class="primary" data-qa="place-order">Place order</button>
        `;
  qa(app, 'place-order').onclick = () => {
    state.placing = true;
    go('#confirmed');
  };
}

function confirmedView() {
  app.innerHTML = `
          ${heading('Order placed')}
          <h2 data-qa="order-confirmed">Your order is on its way to the workshop.</h2>
          <button class="primary" data-qa="shop-again" onclick="location.hash='#catalogue'">Back to the catalogue</button>
        `;
  // A placed order empties the basket.
  state.placing = false;
  state.basket = [];
  state.shownCount = 0;
  renderCount();
}

// ---- basket ops ------------------------------------------------------
function putIn(id) {
  if (!state.basket.includes(id)) {
    state.basket.push(id);
    state.shownCount = state.basket.length;
  }
  renderCount();
}
function takeOut(id) {
  state.basket = state.basket.filter((x) => x !== id);
  // The bug: shownCount does NOT follow basket.length on a take-out, so the
  // count shown is stale until render() below re-syncs it.
  if (!has('stale-badge')) state.shownCount = state.basket.length;
  renderCount();
}

// ---- router ----------------------------------------------------------
function render() {
  // Every change of screen re-syncs the shown count to the real basket,
  // which is why stale-badge "heals itself" once the shopper moves on.
  state.shownCount = state.basket.length;
  const route = location.hash || '#signin';
  if (!state.user && route !== '#signin') return go('#signin');
  // Signed in, the sign-in screen leads on to the catalogue; checkout needs
  // something in the basket; and the confirmation is reached only by placing
  // an order.
  if (state.user && route === '#signin') return go('#catalogue');
  if (!state.basket.length && (route === '#details' || route === '#review'))
    return go('#basket');
  if (route === '#confirmed' && !state.placing) return go('#catalogue');
  if (route === '#signin') signinView();
  else if (route === '#catalogue') catalogueView();
  else if (route === '#basket') basketView();
  else if (route === '#details') detailsView();
  else if (route === '#review') reviewView();
  else if (route === '#confirmed') confirmedView();
  else catalogueView();
  renderCount();
}

window.addEventListener('hashchange', render);
render();
