# AcreetionOS: The User-Friendly Arch Linux Experience

**AcreetionOS** is a modern, privacy-focused Linux distribution built on the powerful **Arch Linux** foundation. Designed for stability and ease of use, it bridges the gap between the bleeding-edge performance of Arch and the reliability required for daily driving.

![AcreetionOS Logo](https://acreetionos.org/logo.webp)

## Why AcreetionOS?

AcreetionOS is engineered for users who want the power of Arch without the hassle. We prioritize **System Sovereignty** and a "human-first" approach to open source.

- **🔰 Beginner Friendly:** A pre-configured **Cinnamon Desktop** environment that feels familiar and intuitive immediately after installation.
- **🚀 High Performance:** Optimized specifically for modern hardware with low-latency kernels and the **Pipewire** audio subsystem.
- **🛡️ Privacy & Stability:** We utilize **XLibre (X11)** for maximum compatibility and stability, avoiding the teething issues of early Wayland adoption.
- **📦 Rolling Release:** Install once, update forever. Always have the latest software without needing to reinstall your OS every six months.

## Technical Highlights

| Feature | Specification |
|---------|--------------|
| **Base** | Arch Linux (Rolling) |
| **Desktop** | Cinnamon (Customized) |
| **Display Server** | XLibre / X11 (Reliability Focus) |
| **Audio** | Pipewire |
| **Filesystem** | EXT4 (Proven Stability) |
| **Bootloader** | GRUB + Systemd-boot |

---

## Development & Contributing

This website is the central hub for the AcreetionOS community, hosted via GitHub Pages.

### Tech Stack

- **Frontend:** Pure HTML5, CSS3, JavaScript (No heavy frameworks)
- **Testing:** Playwright for Firefox-specific validation
- **Deployment:** Automated via GitHub Actions

### Local Development

To run the website locally for testing or development:

```bash
# Clone the repository
git clone https://github.com/AcreetionOS-Code/acreetionos.github.io.git
cd acreetionos.github.io

# Start a local server
python3 -m http.server 8000
# Access at http://localhost:8000
```

### Running Tests

We prioritize Firefox compatibility. To run our local test suite:

```bash
# Install dependencies
npm install

# Run Firefox tests
bash tests/run_firefox_local.sh
```

## Community

AcreetionOS is a community-driven project. We believe in transparency and the separation of identity from technical merit.

- **[Discord Community](https://discord.acreetionos.org)**
- **[Wiki Documentation](wiki.html)**
- **[Source Code](https://github.com/AcreetionOS-Code)**

## License

AcreetionOS is open-source software. See [LICENSE](LICENSE) for details.
---

## 🤖 Pullfrog AI Review

This repository uses **Pullfrog AI** to automatically review pull requests.

Pullfrog is an AI-powered code review agent that analyzes every PR for code quality,
security issues, performance problems, and best practice violations. Reviews appear
as inline PR comments and checks. Trigger manually by commenting `@pullfrog` on any PR.

Powered by OpenRouter.