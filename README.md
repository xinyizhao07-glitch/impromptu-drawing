# Impromptu Drawing

A real-time collaborative drawing space for live sessions. The presenter opens a space and shows a QR code; participants scan it, draw on their phones, and submit — every artwork appears on the presenter's wall with the author's name.

- **No backend required.** Fully static. Real-time sync runs over a public MQTT-over-WebSocket relay, so it works across any network (no shared Wi-Fi needed).
- **Every session is an independent space.** Artworks are stored in the presenter's browser (IndexedDB) and can be exported as a ZIP.
- **Mobile first.** Touch-optimised canvas with pressure-friendly strokes.

## Pages

| File | Role |
| --- | --- |
| `index.html` | Landing page — choose presenter or participant |
| `presenter.html` | Create/delete a space, show QR code, timer, artwork wall, export |
| `room.html` | Join with a code, draw, submit |

## Deploy on GitHub Pages

1. Create a new repository on GitHub (public).
2. Push this folder as the repository root:
   ```bash
   git init
   git add .
   git commit -m "Impromptu Drawing"
   git branch -M main
   git remote add origin https://github.com/<YOUR-USERNAME>/<REPO>.git
   git push -u origin main
   ```
3. In the repository: **Settings → Pages → Build and deployment → Source: Deploy from a branch**
4. Branch: `main`, folder: `/ (root)` → **Save**.
5. Wait ~1 minute. Your site is live at:
   `https://<YOUR-USERNAME>.github.io/<REPO>/`

All asset paths are relative, so the site works whether it is served at the domain root
(`username.github.io`) or in a sub-folder (`username.github.io/<REPO>/`).

## HTTPS note

GitHub Pages forces HTTPS. The MQTT relay connections used here are all `wss://` (secure
WebSocket), so the live site works without any mixed-content warnings. If you open the files
directly from `file://`, MQTT will not connect — always serve over `http(s)://`.

## Local preview

```bash
python -m http.server 5173
# then open http://localhost:5173
```
