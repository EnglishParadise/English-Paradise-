# English Paradise WhatsApp Bot

Initial Node.js implementation for the official WhatsApp Cloud API.

## Included
- WhatsApp webhook verification and incoming-message handling
- Welcome menu
- AI English tutor and English–Telugu translation (OpenAI)
- Three-question MCQ quiz
- PDF note links from environment variables
- Voice-note transcription and English feedback
- Basic book-order enquiry flow
- Daily lesson command and protected admin send endpoint

## Setup
1. Install Node.js 20 or newer.
2. Copy `.env.example` to `.env`.
3. Add your Meta WhatsApp Cloud API token, phone number ID, webhook verification token, and OpenAI API key.
4. Run `npm install`, then `npm start`.
5. Deploy to a host that provides a public HTTPS URL.
6. In Meta's WhatsApp configuration, set the callback URL to `https://YOUR-HOST/webhook`, set the same verify token, and subscribe to the `messages` webhook field.
7. Send `menu` to the connected test/business number.

## Required environment variables
- `WHATSAPP_TOKEN`
- `PHONE_NUMBER_ID`
- `VERIFY_TOKEN`
- `OPENAI_API_KEY` for AI and voice features
- `ADMIN_TOKEN` to protect `/admin/daily-lesson`

Optional PDF links: `GRAMMAR_PDF_URL`, `VOCABULARY_PDF_URL`, `INTERMEDIATE_PDF_URL`.

## Daily lesson delivery
The `lesson` command returns a lesson on demand. The protected `POST /admin/daily-lesson` endpoint sends the current lesson to users who sent `subscribe` during the current server process. Call it from a trusted scheduler with:
`Authorization: Bearer YOUR_ADMIN_TOKEN`

## Before public launch
- Add persistent database storage for subscriptions and book enquiries.
- Verify webhook signatures using your Meta app secret.
- Add structured logging, rate limiting, retries, monitoring, and privacy/data-retention controls.
- Confirm users have opted in. Follow WhatsApp's 24-hour customer-service window and approved message-template rules for business-initiated messages.
- Configure secrets only in the host's environment settings. Never commit `.env` or share access tokens in chat.
- Test with Meta's test number before connecting a production number.

This is a starter implementation, not yet a fully production-hardened commerce system. Order details and subscriptions are stored in memory and are lost on restart.
