# AGENTS

## Package manager

- This repository uses `yarn`, not `npm`.
- Before running any `yarn` command, run `corepack enable` in the current shell session to ensure the correct package manager version is available.
- Follow the version pinned in `package.json` (`yarn@4.5.1`) and the checked-in Yarn release configured in `.yarnrc.yml`.
- Use `yarn install`, `yarn <script>`, and other `yarn` equivalents instead of `npm install`, `npm run`, or other `npm` commands.
- Do not introduce `package-lock.json` or switch the project to another package manager.
