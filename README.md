# muninn

Multi-language protocol and runtime family for Muninn frames, kernels, and client integrations.

## Layout

```text
muninn/
├── protocol/
│   ├── frames-go
│   ├── frames-rs
│   └── frames-ts
├── runtimes/
│   ├── bridge-rs
│   ├── client-ts
│   ├── kernel-rs
│   ├── kernel-ts
│   └── llm-rs
└── meta/
    └── rust
```

## Notes

- Rust crates are managed as a workspace from the repo root.
- TypeScript packages are managed as npm workspaces from the repo root.
- Each imported component keeps its own history via `git subtree`.
