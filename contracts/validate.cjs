const fs = require("node:fs");
const path = require("node:path");
const Ajv2020 = require("ajv/dist/2020");
const addFormats = require("ajv-formats");
const { buildSchema, validateSchema } = require("graphql");

const eventDir = path.join(__dirname, "events", "inventory.stock_low.v1");
const graphqlSchema = buildSchema(
  fs.readFileSync(path.join(__dirname, "graphql", "schema.graphql"), "utf8")
);
const graphqlErrors = validateSchema(graphqlSchema);
if (graphqlErrors.length > 0) {
  throw new Error(`Invalid GraphQL schema: ${graphqlErrors.join(", ")}`);
}
console.log("GraphQL schema: OK");

const schema = JSON.parse(fs.readFileSync(path.join(eventDir, "schema.json"), "utf8"));
const example = JSON.parse(fs.readFileSync(path.join(eventDir, "example.json"), "utf8"));
const ajv = new Ajv2020({ allErrors: true });
addFormats(ajv);
const validateSchemaData = ajv.compile(schema);

function isValidEvent(event) {
  if (!validateSchemaData(event)) {
    return false;
  }
  const crossesThreshold =
    event.previous_stock > event.threshold && event.current_stock <= event.threshold;
  const identifiersAreNotBlank = ["event_id", "sku", "sale_id"].every(
    (field) => event[field].trim().length > 0
  );
  return crossesThreshold && identifiersAreNotBlank;
}

if (!isValidEvent(example)) {
  throw new Error(`Invalid stock-low example: ${ajv.errorsText(validateSchemaData.errors)}`);
}

const invalidExamples = [
  { ...example, occurred_at: "not-a-dateZ" },
  { ...example, current_stock: -1 },
  { ...example, event_version: 2 },
  { ...example, previous_stock: 7 },
  { ...example, current_stock: 8 },
  { ...example, sku: " " },
];
for (const invalid of invalidExamples) {
  if (isValidEvent(invalid)) {
    throw new Error(`Invalid event was accepted: ${JSON.stringify(invalid)}`);
  }
}
console.log(`Stock-low schema and example: OK (${invalidExamples.length} invalid cases rejected)`);

const purchaseRequestDir = path.join(__dirname, "events", "purchases.requests.v1");
const purchaseResultDir = path.join(__dirname, "events", "purchases.results.v1");
function loadJson(directory, filename) {
  return JSON.parse(fs.readFileSync(path.join(directory, filename), "utf8"));
}

const validatePurchaseRequest = ajv.compile(loadJson(purchaseRequestDir, "schema.json"));
const validatePurchaseResult = ajv.compile(loadJson(purchaseResultDir, "schema.json"));
const purchaseRequest = loadJson(purchaseRequestDir, "example.json");
const purchaseResult = loadJson(purchaseResultDir, "example.json");

function checkCases(name, validate, validCases, invalidCases) {
  for (const value of validCases) {
    if (!validate(value)) {
      throw new Error(`${name} rejected valid data: ${ajv.errorsText(validate.errors)}`);
    }
  }
  for (const value of invalidCases) {
    if (validate(value)) {
      throw new Error(`${name} accepted invalid data: ${JSON.stringify(value)}`);
    }
  }
  console.log(`${name}: OK (${validCases.length} valid, ${invalidCases.length} invalid cases)`);
}

const requestWith = (type, payload) => ({ ...purchaseRequest, type, payload });
checkCases("Purchases requests", validatePurchaseRequest, [
  purchaseRequest,
  requestWith("get_need", { event_id: "event-001" }),
  requestWith("list_needs", { sku: "SKU-001", limit: 10, cursor: null }),
  requestWith("list_offers", { sku: "SKU-001", limit: 10, cursor: "next" }),
  requestWith("get_order", { order_id: "order-001" }),
  requestWith("decide_order", {
    order_id: "order-001", expected_revision: 1, decision: "APPROVE", actor_id: "operator-001",
  }),
], [
  { ...purchaseRequest, request_id: " " },
  { ...purchaseRequest, version: 2 },
  requestWith("create_draft", { ...purchaseRequest.payload, quantity: 0 }),
  requestWith("list_offers", { sku: "SKU-001", limit: 101, cursor: null }),
  requestWith("get_order", { event_id: "event-001" }),
  requestWith("decide_order", {
    order_id: "order-001", expected_revision: 1, decision: "APPROVE",
  }),
]);

const offer = purchaseResult.data.offer;
const need = { event_id: "event-001", sku: "SKU-001", current_stock: 7, threshold: 7 };
const resultWith = (type, outcome, data) => ({ ...purchaseResult, type, outcome, data });
checkCases("Purchases results", validatePurchaseResult, [
  purchaseResult,
  resultWith("get_need", "OK", need),
  resultWith("list_needs", "OK", { items: [need], next_cursor: null }),
  resultWith("list_offers", "OK", { items: [offer], next_cursor: "next" }),
  resultWith("get_order", "OK", purchaseResult.data),
  resultWith("decide_order", "OK", {
    ...purchaseResult.data, status: "APPROVED", revision: 2, decided_by: "operator-001",
  }),
  resultWith("get_order", "NOT_FOUND", null),
  resultWith("decide_order", "CONFLICT", null),
], [
  resultWith("get_need", "OK", null),
  resultWith("get_need", "NOT_FOUND", need),
  resultWith("list_offers", "OK", { items: [need], next_cursor: null }),
  resultWith("get_order", "OK", { ...purchaseResult.data, decided_by: "operator-001" }),
  resultWith("decide_order", "OK", { ...purchaseResult.data, status: "APPROVED" }),
  resultWith("decide_order", "OK", purchaseResult.data),
  resultWith("create_draft", "OK", {
    ...purchaseResult.data, status: "APPROVED", revision: 2, decided_by: "operator-001",
  }),
  resultWith("get_order", "OK", {
    ...purchaseResult.data, offer: { ...offer, unit_price: 12.5 },
  }),
]);
