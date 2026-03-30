<div align="center">
<img width="1200" height="475" alt="GHBanner" src="https://github.com/user-attachments/assets/0aa67016-6eaf-458a-adb2-6e31a0763ed6" />
</div>

# Run and deploy your AI Studio app

This contains everything you need to run your app locally.

View your app in AI Studio: https://ai.studio/apps/6b7f0b7f-4185-4a34-91ce-fbf2d10afa96

## Run Locally

**Prerequisites:**  Node.js


1. Install dependencies:
   `npm install`
2. Set the `GEMINI_API_KEY` in [.env.local](.env.local) to your Gemini API key
3. Run the app:
   `npm run dev`

## Mobile camera over HTTPS (recommended)

Most phone browsers require HTTPS for camera access on non-localhost URLs.

1. Add `VITE_DEV_HTTPS="true"` to `.env.local` (or create `.env.https.local`).
2. Start the app with HTTPS enabled:
   `npm run dev:https`
3. Open the HTTPS network URL on your phone and accept the local certificate warning once.
