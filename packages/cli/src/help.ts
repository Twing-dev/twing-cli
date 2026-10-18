/** Command metadata shared by the overview, family help, and command help. */
interface HelpCommand {
  name: string;
  description: string;
  usage: string[];
}

const commands: HelpCommand[] = [
  {
    "name": "init",
    "description": "Configure this repository, or wire this machine with --ghuser",
    "usage": [
      "twing init [--server <url>] [--replace-server] [--invite <code>] [--no-auth] [--no-github] [--enable-enforcement] [--unattended] [--no-trust-codex-hooks]",
      "twing init --ghuser                       (once per machine: work from any directory)"
    ]
  },
  {
    "name": "uninstall",
    "description": "Remove local Twing state and machine wiring",
    "usage": [
      "twing uninstall [--dry-run] [--purge-server-data]"
    ]
  },
  {
    "name": "login",
    "description": "Sign in to a coordinator with a personal access token",
    "usage": [
      "twing login [--server <url>] [--token <pat>]"
    ]
  },
  {
    "name": "keygen",
    "description": "Create a personal access token using an invitation",
    "usage": [
      "twing keygen --invite <code> [--server <url>] [--label <email>]"
    ]
  },
  {
    "name": "whoami",
    "description": "Show your identity on the selected coordinator",
    "usage": [
      "twing whoami [--server <url>] [--show-token]"
    ]
  },
  {
    "name": "servers",
    "description": "List coordinators with cached credentials",
    "usage": [
      "twing servers [--show-token]"
    ]
  },
  {
    "name": "join",
    "description": "Join projects through GitHub membership",
    "usage": [
      "twing join --github [--server <url>]"
    ]
  },
  {
    "name": "daemon",
    "description": "Run the background agent in the foreground",
    "usage": [
      "twing daemon"
    ]
  },
  {
    "name": "daemon restart",
    "description": "Restart the background agent",
    "usage": [
      "twing daemon restart"
    ]
  },
  {
    "name": "align threads",
    "description": "List alignment threads between conflicting designs",
    "usage": [
      "twing align threads [--status open]"
    ]
  },
  {
    "name": "align respond",
    "description": "Post a message to an alignment thread",
    "usage": [
      "twing align respond --finding <threadId> --message \"...\""
    ]
  },
  {
    "name": "align close",
    "description": "Close an alignment thread",
    "usage": [
      "twing align close --finding <threadId>"
    ]
  },
  {
    "name": "admin bootstrap",
    "description": "Create the first administrator on a coordinator",
    "usage": [
      "twing admin bootstrap [--server <url>] --token <bootstrap-token> [--label <email>] [--org-name <name>]"
    ]
  },
  {
    "name": "admin invite",
    "description": "Invite an organization member",
    "usage": [
      "twing admin invite --label <email> [--server <url>] [--role admin|member] [--org-id <id>]"
    ]
  },
  {
    "name": "admin list-invites",
    "description": "List organization invitations",
    "usage": [
      "twing admin list-invites [--server <url>] [--org-id <id>]"
    ]
  },
  {
    "name": "admin revoke-invite",
    "description": "Revoke an organization invitation",
    "usage": [
      "twing admin revoke-invite --code <invite-code> [--server <url>]"
    ]
  },
  {
    "name": "admin revoke-developer",
    "description": "Revoke a developer’s coordinator access",
    "usage": [
      "twing admin revoke-developer --developer-id <id> [--server <url>]"
    ]
  },
  {
    "name": "admin list-developers",
    "description": "List organization developers",
    "usage": [
      "twing admin list-developers [--server <url>] [--org-id <id>]"
    ]
  },
  {
    "name": "project invite",
    "description": "Invite a project member",
    "usage": [
      "twing project invite --label <email> [--project <id>] [--server <url>] [--role admin|member]"
    ]
  },
  {
    "name": "project list-invites",
    "description": "List project invitations",
    "usage": [
      "twing project list-invites [--project <id>] [--server <url>]"
    ]
  },
  {
    "name": "project revoke-invite",
    "description": "Revoke a project invitation",
    "usage": [
      "twing project revoke-invite --code <invite-code> [--server <url>]"
    ]
  },
  {
    "name": "project remove-developer",
    "description": "Remove a developer from a project",
    "usage": [
      "twing project remove-developer --developer-id <id> [--project <id>] [--server <url>]"
    ]
  },
  {
    "name": "project list-developers",
    "description": "List project developers",
    "usage": [
      "twing project list-developers [--project <id>] [--server <url>]"
    ]
  },
  {
    "name": "project enable-enforcement",
    "description": "Write repository bootstrap hooks for the team",
    "usage": [
      "twing project enable-enforcement"
    ]
  },
  {
    "name": "project disable-enforcement",
    "description": "Remove repository bootstrap hook entries",
    "usage": [
      "twing project disable-enforcement"
    ]
  },
  {
    "name": "design register",
    "description": "Register a design before editing (usually agent managed)",
    "usage": [
      "twing design register --session <id> --summary \"...\" --plan \"...\" --creates a,b --touches c,d --depends-on e,f [--group <groupId>] [--server <url>] [--label <email>]",
      "twing design register --from <file.yml|->   (structured template: goal + plan + changes[action/target/intent]; - reads stdin) [--server <url>]"
    ]
  },
  {
    "name": "design amend",
    "description": "Update an existing design or append structured changes",
    "usage": [
      "twing design amend --id <designId> --from <file.yml|->   (append change items to an existing design) [--server <url>]",
      "twing design amend --id <designId> [--touches a,b] [--creates c,d] [--depends-on e,f] [--summary \"...\"] [--group <groupId>] [--server <url>]",
      "twing design amend --id <designId> --reassign-project   (run from the correct repo -- moves an open, unencumbered design there) [--server <url>]"
    ]
  },
  {
    "name": "design resolve",
    "description": "Adopt another design or justify a divergence",
    "usage": [
      "twing design resolve --id <designId> (--adopt <designId> | --justify \"...\") [--server <url>]"
    ]
  },
  {
    "name": "design resume",
    "description": "Resume an existing design for a coding session",
    "usage": [
      "twing design resume --id <designId> [--session <id>] [--touches a,b] [--creates c,d] [--depends-on e,f] [--server <url>]"
    ]
  },
  {
    "name": "design close",
    "description": "Close a design",
    "usage": [
      "twing design close --id <designId> [--server <url>]"
    ]
  },
  {
    "name": "design list",
    "description": "List designs for this repository",
    "usage": [
      "twing design list [--status open] [--mine] [--server <url>]"
    ]
  },
  {
    "name": "design reviews",
    "description": "List or decide pending divergence reviews",
    "usage": [
      "twing design reviews [--decide <reviewId> --decision approve|reject] [--server <url>]"
    ]
  },
  {
    "name": "design comments",
    "description": "Read review comments; answer them in Twing Monitor",
    "usage": [
      "twing design comments [<designId>] [--session <id>] [--json] [--server <url>]"
    ]
  },
  {
    "name": "design enable-gate",
    "description": "Enable the design gate locally for this project",
    "usage": [
      "twing design enable-gate"
    ]
  },
  {
    "name": "design disable-gate",
    "description": "Disable the design gate locally for this project",
    "usage": [
      "twing design disable-gate"
    ]
  },
  {
    "name": "constraints list",
    "description": "List project constraints",
    "usage": [
      "twing constraints list [--project <id>] [--server <url>]"
    ]
  },
  {
    "name": "constraints remove",
    "description": "Delete a constraint (requires administrator access)",
    "usage": [
      "twing constraints remove --id <constraintId> [--server <url>]"
    ]
  }
];

const groups = [
  { title: "Getting started", names: ["init", "login", "join", "whoami"] },
  { title: "Review and coordination", names: ["design", "align", "constraints"] },
  { title: "Administration", names: ["project", "admin"] },
  { title: "Machine and credentials", names: ["servers", "keygen", "daemon", "uninstall"] },
];
const families: Record<string, string> = {
  design: "Register, inspect, and review designs",
  align: "Read and discuss design conflict threads",
  constraints: "Inspect and manage project constraints",
  project: "Manage project membership and repository enforcement",
  admin: "Manage coordinator and organization access",
};

function rows(items: { name: string; description: string }[]): string[] {
  const width = Math.max(...items.map(item => item.name.length));
  return items.map(item => `  ${item.name.padEnd(width)}  ${item.description}`);
}

export function formatHelp(topic: string[] = []): string {
  const name = topic.join(" ");
  if (name === "design comment" || name === "design comment reply" || name === "design comment resolve") {
    return "Design comment replies and resolutions have moved to Twing Monitor.\nUse `twing design comments --help` to read comments from the terminal.";
  }
  const exact = commands.find(command => command.name === name);
  if (exact && (topic.length > 1 || !["daemon"].includes(name))) {
    return [exact.description, "", "Usage:", ...exact.usage.map(usage => `  ${usage}`), "", "Global options:", "  -C, --directory <dir>  Act on the repository at <dir>", "  -h, --help             Show help without running the command"].join("\n");
  }
  if (families[name] || name === "daemon") {
    const children = commands.filter(command => command.name.startsWith(`${name} `));
    return [families[name] ?? "Run or restart the background agent", "", `Usage: twing ${name} <command> [options]`, ...(name === "daemon" ? ["       twing daemon  (run in the foreground)"] : []), "", "Commands:", ...rows(children.map(command => ({ ...command, name: command.name.slice(name.length + 1) }))), "", `Run twing ${name} <command> --help for usage and options.`].join("\n");
  }
  if (name) return `Unknown help topic: ${name}\n\n${formatHelp()}`;
  const output = ["Twing - coordinate designs across coding agents", "", "Usage: twing [-C <dir>] <command> [options]"];
  for (const group of groups) {
    output.push("", `${group.title}:`, ...rows(group.names.map(name => ({ name, description: families[name] ?? commands.find(command => command.name === name)!.description }))));
  }
  output.push("", "Global options:", "  -C, --directory <dir>  Act on the repository at <dir>", "  -h, --help             Show help", "  -v, --version          Show the CLI version", "", "Run twing <command> --help for commands, usage, and options.", "Examples:", "  twing init --server <url>", "  twing design list --mine", "  twing design --help");
  return output.join("\n");
}
