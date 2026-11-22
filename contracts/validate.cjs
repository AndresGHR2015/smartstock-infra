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
