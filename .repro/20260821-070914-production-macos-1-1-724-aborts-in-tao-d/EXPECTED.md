# Expected Behavior

- Updating and relaunching should open the existing local database without a native process crash.
- A schema change that replaces plaintext with client-encrypted content must explicitly handle pre-existing rows before adding a `NOT NULL` encrypted column.
- If a bundled child still cannot start, the desktop app should surface a controlled startup error with a diagnostic reason instead of unwinding through the macOS application delegate.
