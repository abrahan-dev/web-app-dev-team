export enum Role {
  Specifier = "specifier",
  Architect = "architect",
  UiDesigner = "ui-designer",
  DataEngineer = "data-engineer",
  BackendCoder = "backend-coder",
  FrontendCoder = "frontend-coder",
  Qa = "qa",
}

export const roles = Object.values(Role) as [Role, ...Role[]];
