// Best-effort signup confirmation email. If SMTP isn't configured in .env, signup still works -
// we just log a note to the server console instead of sending anything, so the app never
// blocks on email setup.
import nodemailer from 'nodemailer';

const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_FROM } = process.env;
const isConfigured = Boolean(SMTP_HOST && SMTP_PORT && SMTP_USER && SMTP_PASS);

const transporter = isConfigured
  ? nodemailer.createTransport({
      host: SMTP_HOST,
      port: Number(SMTP_PORT),
      secure: Number(SMTP_PORT) === 465,
      auth: { user: SMTP_USER, pass: SMTP_PASS },
    })
  : null;

export async function sendSignupEmail(toEmail) {
  if (!transporter) {
    console.log(`[mailer] SMTP not configured - skipping signup email to ${toEmail}. See server/.env.example.`);
    return;
  }
  try {
    await transporter.sendMail({
      from: SMTP_FROM || SMTP_USER,
      to: toEmail,
      subject: 'You have been successfully signed up for Trading Bot',
      text: 'Welcome! Your account has been created and you are now signed up for Trading Bot. Log in any time to pick up where you left off.',
      html: '<p>Welcome! Your account has been created and you are now signed up for <strong>Trading Bot</strong>.</p><p>Log in any time to pick up where you left off.</p>',
    });
  } catch (e) {
    // Never let a flaky SMTP provider break signup - the account is already created either way.
    console.error('[mailer] Failed to send signup email:', e.message);
  }
}
