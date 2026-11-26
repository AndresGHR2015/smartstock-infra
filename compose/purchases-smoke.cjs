const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');

const baseUrl = process.env.GATEWAY_URL || `http://127.0.0.1:${process.env.GATEWAY_HTTP_PORT || 3001}`;
const webUrl = process.env.WEB_URL || `http://127.0.0.1:${process.env.DEMO_HTTP_PORT || 8080}`;
const token = process.env.PURCHASES_INTERNAL_TOKEN || 'smartstock-local-development-only';
const project = process.env.COMPOSE_PROJECT_NAME;
const restartServices = process.env.SMOKE_ALLOW_RESTARTS === 'true';
const testTransportFailures = process.env.SMOKE_TRANSPORT_FAILURES === 'true';
const allowDecisions = process.env.PURCHASES_ALLOW_LOCAL_DECISIONS === 'true';
const prefix = `smoke-${randomUUID()}`;

async function http(route, { body, key, authorized = true, origin = baseUrl } = {}) {
  const headers = { connection: 'close' };
  if (authorized) headers.authorization = `Bearer ${token}`;
  if (body) headers['content-type'] = 'application/json';
  if (key) headers['idempotency-key'] = key;
  const response = await fetch(`${origin}${route}`, {
    method: body ? 'POST' : 'GET',
    headers,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(10000),
  });
  const contentType = response.headers.get('content-type') || '';
  const data = contentType.includes('application/json') ? await response.json() : await response.text();
  return { status: response.status, body: data };
}

async function until(read, accept, label, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try {
      last = await read();
      if (accept(last)) return last;
    } catch (error) {
      last = error.message;
    }
    await delay(500);
  }
  throw new Error(`Timeout: ${label}. Último valor: ${JSON.stringify(last)}`);
}

async function submit(type, payload, key = `${prefix}-${randomUUID()}`) {
  const response = await http('/internal/purchases/requests', { body: { type, payload }, key });
  assert.equal(response.status, 202, JSON.stringify(response));
  assert.match(
    response.body.request_id,
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
  );
  return response.body;
}

async function completed(requestId) {
  const response = await until(
    () => http(`/internal/purchases/requests/${encodeURIComponent(requestId)}`),
    (value) => value.status === 200 && value.body.status === 'COMPLETED',
    `resultado de ${requestId}`,
  );
  return response.body;
}

async function operation(type, payload, expectedOutcome = 'OK', key) {
  const accepted = await submit(type, payload, key);
  const response = await completed(accepted.request_id);
  assert.equal(response.type, type);
  assert.equal(response.result.request_id, accepted.request_id);
  assert.equal(response.result.outcome, expectedOutcome, JSON.stringify(response));
  return response;
}

async function graphql(query, variables = {}) {
  const response = await http('/graphql', {
    body: { query, variables }, origin: webUrl, authorized: false,
  });
  assert.equal(response.status, 200, `GraphQL vía Nginx devolvió HTTP ${response.status}`);
  assert.equal(response.body.errors, undefined, JSON.stringify(response.body));
  return response.body.data;
}

function compose(...args) {
  assert.match(project || '', /^smartstock-purchases-[a-zA-Z0-9-]+$/,
    'Los reinicios solo están permitidos en un proyecto aislado smartstock-purchases-*.');
  execFileSync('docker', ['compose', '-p', project, ...args], {
    cwd: path.join(__dirname, '..'),
    stdio: 'inherit',
    timeout: 120000,
  });
}

async function main() {
  for (const url of [new URL(baseUrl), new URL(webUrl)]) {
    assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname),
      'La prueba solo admite el Gateway y el proxy web en loopback.');
  }
  assert.notEqual(new URL(baseUrl).origin, new URL(webUrl).origin,
    'Gateway y proxy web deben tener orígenes distintos.');
  if (restartServices) {
    assert.match(project || '', /^smartstock-purchases-[a-zA-Z0-9-]+$/,
      'Elegir un proyecto aislado smartstock-purchases-* antes de ejecutar la prueba.');
  }
  assert.ok(!testTransportFailures || restartServices,
    'SMOKE_TRANSPORT_FAILURES exige SMOKE_ALLOW_RESTARTS=true en un proyecto aislado.');
  await until(
    () => http('/internal/purchases/requests/no-such-request'),
    (response) => response.status === 404,
    'Gateway disponible',
  );
  assert.equal((await http('/internal/purchases/requests/missing', { authorized: false })).status, 401);
  const unauthorizedSubmit = await http('/internal/purchases/requests', {
    authorized: false,
    body: { type: 'list_offers', payload: { sku: 'SKU-001', limit: 10, cursor: null } },
  });
  assert.equal(unauthorizedSubmit.status, 401);
  const unauthorizedRetry = await http('/internal/purchases/requests/missing/retry', {
    authorized: false,
    body: {},
  });
  assert.equal(unauthorizedRetry.status, 401);
  const invalid = await http('/internal/purchases/requests', {
    body: { type: 'create_draft', payload: { quantity: 0 } },
  });
  assert.equal(invalid.status, 400);

  const productQuery = 'query { product(sku:"SKU-001") { stock threshold } }';
  const waitForWebProduct = (stock, label) => until(
    () => graphql(productQuery),
    (data) => data.product?.stock === stock && data.product.threshold === 7,
    label,
  );
  const initial = await until(
    () => graphql(productQuery),
    (data) => data.product !== null,
    'Inventario disponible por GraphQL vía Nginx',
  );
  assert.deepEqual(initial.product, { stock: 10, threshold: 7 },
    'Esta prueba necesita un proyecto nuevo; no reutilizar volúmenes con ventas previas.');
  const saleId = `${prefix}-sale`;
  const sale = await graphql(
    'mutation($input:CreateSaleInput!) { createSale(input:$input) { outcome } }',
    { input: { saleId, sku: 'SKU-001', quantity: 3 } },
  );
  assert.ok(['ACCEPTED', 'UNKNOWN'].includes(sale.createSale.outcome));
  await until(
    () => graphql('query($id:ID!) { sale(id:$id) { status } }', { id: saleId }),
    (data) => data.sale?.status === 'CONFIRMED',
    'venta confirmada',
  );
  assert.equal((await graphql(productQuery)).product.stock, 7);
  const needs = await until(
    () => operation('list_needs', { sku: 'SKU-001', limit: 10, cursor: null }),
    (response) => response.result.data.items.length > 0,
    'alerta real de Inventario persistida en Compras',
  );
  const need = needs.result.data.items[0];
  const readNeed = await operation('get_need', { event_id: need.event_id });
  assert.deepEqual(readNeed.result.data, need);
  await operation('get_need', { event_id: `${prefix}-missing` }, 'NOT_FOUND');
  console.log('OK: venta real → Inventario → Kafka → necesidad consultada desde Gateway.');

  const page = await operation('list_offers', { sku: 'SKU-001', limit: 1, cursor: null });
  assert.equal(page.result.data.items.length, 1);
  assert.ok(page.result.data.next_cursor);
  const next = await operation('list_offers', {
    sku: 'SKU-001', limit: 1, cursor: page.result.data.next_cursor,
  });
  assert.notEqual(next.result.data.items[0].offer_id, page.result.data.items[0].offer_id);
  await operation('list_offers', {
    sku: 'OTHER-SKU', limit: 1, cursor: page.result.data.next_cursor,
  }, 'INVALID_ARGUMENT');
  await operation('list_offers', { sku: 'SKU-001', limit: 1, cursor: 'invalid' }, 'INVALID_ARGUMENT');

  const offer = page.result.data.items[0];
  await operation('create_draft', {
    need_event_id: need.event_id, offer_id: offer.offer_id, quantity: 1,
  }, 'INVALID_ARGUMENT');
  const draftPayload = {
    need_event_id: need.event_id,
    offer_id: offer.offer_id,
    quantity: offer.minimum_quantity,
  };
  const draftKey = `${prefix}-draft`;
  const draft = await operation('create_draft', draftPayload, 'OK', draftKey);
  assert.equal(draft.result.data.status, 'DRAFT');
  const orderId = draft.result.data.order_id;
  assert.ok(orderId);
  const replay = await submit('create_draft', draftPayload, draftKey);
  assert.deepEqual(replay, draft);
  const conflict = await http('/internal/purchases/requests', {
    key: draftKey,
    body: { type: 'create_draft', payload: { ...draftPayload, quantity: draftPayload.quantity + 1 } },
  });
  assert.equal(conflict.status, 409);
  await operation('create_draft', { ...draftPayload, order_id: orderId }, 'CONFLICT');
  const readOrder = await operation('get_order', { order_id: orderId });
  assert.deepEqual(readOrder.result.data, draft.result.data);
  await operation('get_order', { order_id: `${prefix}-missing` }, 'NOT_FOUND');
  console.log('OK: ofertas paginadas, borrador, idempotencia, conflicto y consulta de orden.');

  const decision = {
    order_id: orderId,
    expected_revision: 1,
    decision: 'APPROVE',
    actor_id: 'local-operator',
  };
  if (allowDecisions) {
    const approved = await operation('decide_order', decision);
    assert.equal(approved.result.data.status, 'APPROVED');
    assert.equal(approved.result.data.revision, 2);
    await operation('decide_order', { ...decision, decision: 'REJECT' }, 'CONFLICT');
    const otherDraft = await operation('create_draft', draftPayload);
    const rejected = await operation('decide_order', {
      ...decision,
      order_id: otherDraft.result.data.order_id,
      decision: 'REJECT',
    });
    assert.equal(rejected.result.data.status, 'REJECTED');
    console.log('OK: aprobación y rechazo locales; revisión obsoleta no modifica la orden.');
  } else {
    const denied = await http('/internal/purchases/requests', {
      body: { type: 'decide_order', payload: decision },
    });
    assert.equal(denied.status, 403);
    console.log('OK: decisiones deshabilitadas por defecto.');
  }

  if (restartServices) {
    compose('stop', 'compras');
    try {
      const pending = await submit('get_order', { order_id: orderId });
      assert.equal(pending.status, 'PENDING');
      compose('restart', 'gateway');
      const recovered = await until(
        () => http(`/internal/purchases/requests/${pending.request_id}`),
        (value) => value.status === 200,
        'solicitud conservada tras reiniciar Gateway',
      );
      assert.equal(recovered.body.status, 'PENDING');
      await waitForWebProduct(7, 'GraphQL vía Nginx recuperado tras reiniciar Gateway');
      compose('start', 'compras');
      const resumed = await completed(pending.request_id);
      assert.equal(resumed.result.outcome, 'OK');
      compose('restart', 'gateway', 'compras');
      const persisted = await until(
        () => http(`/internal/purchases/requests/${draft.request_id}`),
        (value) => value.status === 200,
        'resultado conservado tras reiniciar ambos servicios',
      );
      assert.deepEqual(persisted.body, draft);
      await waitForWebProduct(7, 'GraphQL vía Nginx recuperado tras reiniciar Gateway y Compras');
      console.log('OK: recuperación de pendientes, resultados y GraphQL vía Nginx después de reinicios.');
    } finally {
      compose('start', 'compras');
    }
  }
  if (testTransportFailures) {
    compose('stop', 'compras');
    try {
      const pending = await submit('list_offers', { sku: 'SKU-001', limit: 10, cursor: null });
      await until(
        async () => execFileSync('docker', [
          'compose', '-p', project, 'exec', '-T', 'gateway-db',
          'psql', '-U', 'gateway', '-d', 'gateway', '-tAc',
          `SELECT last_sent_at IS NOT NULL FROM purchase_requests WHERE request_id = '${pending.request_id}'`,
        ], { cwd: path.join(__dirname, '..'), encoding: 'utf8', timeout: 10000 }).trim(),
        (value) => value === 't',
        'solicitud publicada antes de interrumpir PostgreSQL',
      );
      compose('stop', 'gateway-db');
      compose('start', 'compras');
      console.log('Probando pérdida de PostgreSQL durante 40 s (más que la sesión Kafka).');
      await delay(40000);
      compose('start', 'gateway-db');
      const recovered = await completed(pending.request_id);
      assert.equal(recovered.result.outcome, 'OK');
      console.log('OK: PostgreSQL recuperado sin reiniciar Gateway ni perder la membresía Kafka.');
    } finally {
      compose('start', 'gateway-db', 'compras');
    }
    try {
      compose('stop', 'kafka');
      const offline = await submit('list_offers', { sku: 'SKU-001', limit: 10, cursor: null });
      assert.equal(offline.status, 'PENDING');
      console.log('Probando pérdida de Kafka durante 40 s.');
      await delay(40000);
      compose('start', 'kafka');
      const recovered = await completed(offline.request_id);
      assert.equal(recovered.result.outcome, 'OK');
      console.log('OK: Kafka recuperado; solicitud original completada sin reinicios de servicios.');
    } finally {
      compose('start', 'kafka');
    }
  }
  console.log(JSON.stringify({
    status: 'PASS',
    gateway: baseUrl,
    web: webUrl,
    sale_id: saleId,
    event_id: need.event_id,
    request_id: draft.request_id,
    order_id: orderId,
    restarts_tested: restartServices,
    transport_failures_tested: testTransportFailures,
    local_decisions_tested: allowDecisions,
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
