MKS AI PUBLIC v1
=================

WHAT THIS IS
A public-ready starter web app with:
- Email/password signup and login
- Secure server-side password hashing (Node scrypt)
- HTTP-only session cookies
- Free monthly request limits
- Per-IP basic rate limiting
- User usage counter
- Admin role by ADMIN_EMAIL
- YouTube, Advertising, Business, Social Media, Writing, Education, Marketing, Prompt Maker and Translation modes
- Copy/download answers

LOCAL TEST (Windows)
1. Open PowerShell in this folder.
2. Set:
   $env:OPENAI_API_KEY = 'YOUR_NEW_API_KEY'
3. Optional admin:
   $env:ADMIN_EMAIL = 'your@email.com'
   $env:ADMIN_PASSWORD = 'choose-a-strong-password'
   (The admin password is a separate deployment setting; users still register normally.)
4. Run:
   node server.js
5. Open:
   http://localhost:3000

PUBLIC DEPLOYMENT
Use a Node.js host/VPS/managed service that supports environment variables and persistent storage.
Set:
OPENAI_API_KEY
ADMIN_EMAIL
ADMIN_PASSWORD
FREE_REQUESTS=30
NODE_ENV=production

IMPORTANT SECURITY
- Never put OPENAI_API_KEY in index.html or client-side JavaScript.
- Never publish your API key in GitHub, screenshots, browser code or ZIP files.
- The included JSON database is suitable for a prototype/small deployment. For serious public traffic, move users/sessions/usage to PostgreSQL/Redis and add email verification, password reset, stronger rate limiting, logging, abuse controls and HTTPS.
- Put the app behind HTTPS in production.
- Public users consume the owner's API budget. Set usage limits before sharing the link.
- Payment integration is NOT included in v1. Add Stripe/Razorpay/other compliant billing only after the core app is deployed and tested.

MODEL
The app is configured for gpt-5.6-luna. Change the model string in server.js if you later choose another supported model.
