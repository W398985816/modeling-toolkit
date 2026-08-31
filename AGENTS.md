# Repository Guidelines

## Project Structure & Module Organization

This repository is a dependency-free static website for browser-based 3D modeling tools. Production files live in `public/`:

- `index.html` is the tool catalog and public entry point.
- `掐丝生成器.html`, `镂空生成器.html`, and `拼图生成器.html` are standalone applications.
- `netlify.toml` publishes `public/` without a build step.
- `.gitignore` excludes local macOS and Netlify metadata.

Keep deployable files in `public/`. Do not add generated STL, SVG, 3MF, screenshots, experiments, or backup HTML files to the repository root.

## Build, Test, and Development Commands

No package installation or compilation is required. Run a local static server from the repository root:

```bash
python3 -m http.server 8000 --directory public
```

Then open `http://localhost:8000/`. Check repository state before committing:

```bash
git status -sb
git diff --check
```

Netlify reads `netlify.toml` and deploys `public/` directly whenever the production branch is published.

## Coding Style & Naming Conventions

Preserve the existing standalone-HTML architecture and local style of the file being edited. Use two-space indentation for HTML, CSS, and JavaScript. Prefer `const` and `let`, descriptive camelCase JavaScript names, kebab-case CSS classes, and semantic HTML. Add comments only where geometry, image processing, or export logic is not self-explanatory. Avoid unrelated formatting or framework migrations.

Keep visible product names in Simplified Chinese. When adding public routes, prefer short ASCII filenames for stable shared URLs; update links in `public/index.html` in the same change.

## Testing Guidelines

There is no automated test suite. Manually verify the homepage and every modified generator in a desktop browser. For generator changes, test image upload, parameter updates, preview interaction, and each affected SVG/STL/3MF download. Confirm there are no console errors and that downloaded models open in the intended modeling or slicing software.

## Commit & Pull Request Guidelines

Recent commits use concise Chinese, outcome-focused messages, for example `清理仓库并统一生产目录`. Keep each commit limited to one logical change. Pull requests should include a short problem statement, implementation summary, manual verification results, and before/after screenshots for visible UI changes. Note any file-format or slicer compatibility impact explicitly.
