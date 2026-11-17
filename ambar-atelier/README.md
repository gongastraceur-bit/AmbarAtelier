# Âmbar — Atelier de Beleza

Site and booking system. Plain HTML/CSS/JS, plus a small Node server with **no dependencies**.

```
public/          what visitors download (site, legal pages, 404, fonts)
server.mjs       web server + booking API + admin panel
data/            bookings and subscribers (created automatically, not served, git-ignored)
```

## Run it

Needs Node 20 or newer.

```bash
node server.mjs
```

Then open http://localhost:5174. All settings are environment variables; see `.env.example`.

## How bookings work

1. The visitor picks a service. Only the professionals who do that service can be chosen.
2. They pick a date. Available times come from the server. It accounts for:
   - opening hours (Tue–Fri 10h–20h, Sat 9h–19h);
   - how long the service takes;
   - who is already booked;
   - Portuguese public holidays and Santo António;
   - a one-hour minimum notice for same-day bookings.
3. When they submit, the server checks the slot again and saves it. If two people pick the same slot at the same moment, the second person sees "this time was just taken" and is sent back to choose another.
4. The booking is saved as **pending**. If email is set up, the client gets a "we received your request" email and the salon gets the full details.
5. The salon confirms or cancels at `/admin`. Each action emails the client automatically.

Spam protection: a hidden honeypot field, rate limiting (10 bookings per 15 minutes per IP), a request size limit, same-origin checks, and server-side validation of every field.

### Closing extra days

Create `data/closures.json` with an array of dates, for example `["2026-08-10", "2026-08-11"]`, for holidays or training days.

### Changing services, prices or team

The service list (duration, price and who does it) is in `server.mjs` under `SERVICES`. The radio buttons in `public/index.html` must use the same names.

## Demo on Cloudflare (no backend)

`wrangler.jsonc` publishes only `public/` as a static site, and `public/_headers` adds the security headers. Without `server.mjs`, the page detects that `/api` is missing and switches the booking form and newsletter to **demo mode**:

- availability is simulated with the same rules (hours, durations, staff, holidays);
- a slot booked during the visit shows as taken;
- submitting shows a reference number.

Nothing is stored or emailed in demo mode.

Cloudflare settings: no build command, deploy command `npx wrangler deploy`. If this folder isn't the root of the Git repository, set the project's **Root directory** to `ambar-atelier`.

## Deploying

The server needs a host that runs Node and has a **persistent disk** for `data/`, such as Render, Railway, Fly.io or a small VPS. Static-only hosts like Netlify or GitHub Pages can't run the booking API.

Set at least `ADMIN_PASSWORD`, `HTTPS=1` and, when behind a proxy, `TRUST_PROXY=1`. For email, create a Resend account, verify the domain, then set `RESEND_API_KEY`, `MAIL_FROM` and `SALON_EMAIL`.

## Performance and security built in

- **Fonts:** self-hosted variable fonts (3 files, about 100 KB), preloaded, with metric-matched fallbacks so the page doesn't shift when they load.
- **Compression:** Brotli/gzip.
- **Caching:** ETags on everything. CSS and JS get content-hashed URLs, so they can be cached for a year and still update on every deploy.
- **Content-Security-Policy:** inline scripts are allowed only by hash.
- **Other headers:** HSTS, nosniff, frame-deny and Permissions-Policy.
- **Images:** responsive `srcset`/`sizes` on every photo.

## Before launch

- Replace the placeholder company details (NIPC, address, phone) in `public/index.html`, `public/privacidade.html`, `public/termos.html` and in `server.mjs` emails.
- Have a lawyer review the privacy policy and terms; they are a solid starting template, not legal advice.
- Replace the Unsplash photos with your own shoot. Self-host them in `public/img/`, then remove `https://images.unsplash.com` from the CSP in `server.mjs`.
