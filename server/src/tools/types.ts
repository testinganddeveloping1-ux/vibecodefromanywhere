export type ToolId = "codex" | "claude" | "opencode";

export type CodexCaps = {
  installed: boolean;
  path?: string;
  version?: string;
  configPath?: string;
  sandboxModes: string[];
  approvalPolicies: string[];
  supports: {
    cd: boolean;
    model: boolean;
    addDir: boolean;
    search: boolean;
    fullAuto: boolean;
    bypassApprovalsSandbox: boolean;
    configOverride: boolean;
    noAltScreen: boolean;
  };
};

export type ClaudeCaps = {
  installed: boolean;
  path?: string;
  version?: string;
  permissionModes: string[];
  supports: {
    permissionMode: boolean;
    dangerouslySkipPermissions: boolean;
    model: boolean;
    addDir: boolean;
    settings: boolean;
  };
};

export type OpenCodeCaps = {
  installed: boolean;
  path?: string;
  version?: string;
  supports: {
    model: boolean;
    agent: boolean;
    serve: boolean;
    web: boolean;
    attach: boolean;
    hostnamePort: boolean;
  };
};

export type ToolCaps = {
  codex: CodexCaps;
  claude: ClaudeCaps;
  opencode: OpenCodeCaps;
  scannedAt: number;
};
