# Install linearctl

linearctl is an agent-first CLI for the Linear API. Follow these steps to install and configure it.

## 1. Install the binary

```bash
curl -fsSL https://raw.githubusercontent.com/qwrobins/linearctl/main/install.sh | sh
```

This detects your OS and architecture and installs to `~/.local/bin/linearctl`. On Debian/Ubuntu it uses a `.deb` package automatically.

If `~/.local/bin` is not in your PATH, add it:

```bash
export PATH="$HOME/.local/bin:$PATH"
```

## 2. Install agent skills

```bash
linearctl skills install
```

This auto-detects installed agents (Claude Code, Codex) and writes the skills to the right directories.

## 3. Set up authentication

Ask the user for their Linear API key. They can create one at https://linear.app/settings/api.

Once you have the key, store it in an environment variable and run:

```bash
export LINEAR_API_KEY=<their-api-key>
linearctl auth login --profile default --api-key-env LINEAR_API_KEY --set-default
```

## 4. Set a default team

```bash
linearctl team list
```

Ask the user which team they primarily work in, then:

```bash
linearctl team get <team-key> --set-default
```

## 5. Verify

```bash
linearctl auth whoami
```

This should show the user's name, email, and workspace.

## Done

The CLI is ready. Use the linearctl skill for command routing and examples.
