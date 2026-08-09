export interface GherkinValidation {
  featureId: string | null;
  featureTitle: string | null;
  scenarios: string[];
  errors: string[];
}

type Keyword = "Feature" | "Background" | "Scenario" | "Given" | "When" | "Then" | "And";

interface Statement {
  keyword: Keyword;
  value: string;
  line: number;
}

interface ScenarioState {
  name: string;
  given: boolean;
  when: boolean;
  then: boolean;
}

interface ValidationState {
  featureTitle: string | null;
  currentScenario: ScenarioState | null;
  scenarios: string[];
  errors: string[];
}

function slug(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function parseStatement(line: string, lineNumber: number, errors: string[]): Statement | null {
  const match = /^(Feature|Background|Scenario|Given|When|Then|And):?\s*(.*)$/.exec(line);

  if (!match) {
    errors.push(`Line ${lineNumber} uses unsupported Gherkin syntax: ${line}`);

    return null;
  }

  const keyword = match[1] as Keyword;
  const value = (match[2] ?? "").trim();

  if (!value) {
    errors.push(`Line ${lineNumber} has an empty ${keyword} statement.`);
  }

  return { keyword, value, line: lineNumber };
}

function finishScenario(scenario: ScenarioState | null, errors: string[]): void {
  if (!scenario) {
    return;
  }

  for (const keyword of ["Given", "When", "Then"] as const) {
    if (!scenario[keyword.toLowerCase() as "given" | "when" | "then"]) {
      errors.push(`Scenario "${scenario.name}" has no ${keyword} step.`);
    }
  }
}

function startScenario(statement: Statement, state: ValidationState): void {
  finishScenario(state.currentScenario, state.errors);

  if (state.scenarios.includes(statement.value)) {
    state.errors.push(`Scenario name "${statement.value}" is duplicated.`);
  }

  state.scenarios.push(statement.value);
  state.currentScenario = {
    name: statement.value,
    given: false,
    when: false,
    then: false,
  };
}

function markScenarioStep(state: ValidationState, step: "given" | "when" | "then"): void {
  if (state.currentScenario) {
    state.currentScenario[step] = true;
  }
}

function applyStatement(statement: Statement, state: ValidationState): void {
  switch (statement.keyword) {
    case "Feature":
      if (state.featureTitle !== null) {
        state.errors.push("A specification must contain exactly one Feature.");
      }

      state.featureTitle = statement.value;
      break;
    case "Scenario":
      startScenario(statement, state);
      break;
    case "Given":
      markScenarioStep(state, "given");
      break;
    case "When":
      markScenarioStep(state, "when");
      break;
    case "Then":
      markScenarioStep(state, "then");
      break;
    case "Background":
    case "And":
      break;
  }
}

function finishValidation(state: ValidationState): GherkinValidation {
  finishScenario(state.currentScenario, state.errors);

  if (state.featureTitle === null) {
    state.errors.push("The specification has no Feature.");
  }

  if (state.scenarios.length === 0) {
    state.errors.push("The specification must contain at least one Scenario.");
  }

  return {
    featureId: state.featureTitle ? slug(state.featureTitle) : null,
    featureTitle: state.featureTitle,
    scenarios: state.scenarios,
    errors: state.errors,
  };
}

export function validateGherkin(source: string): GherkinValidation {
  const state: ValidationState = {
    featureTitle: null,
    currentScenario: null,
    scenarios: [],
    errors: [],
  };

  for (const [index, raw] of source.split("\n").entries()) {
    const line = raw.trim();

    if (!line || line.startsWith("#")) {
      continue;
    }

    const statement = parseStatement(line, index + 1, state.errors);

    if (statement) {
      applyStatement(statement, state);
    }
  }

  return finishValidation(state);
}
