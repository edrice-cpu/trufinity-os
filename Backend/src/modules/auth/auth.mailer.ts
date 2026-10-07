import nodemailer, { type Transporter } from 'nodemailer';
import { env } from '../../config/env';
import { logger } from '../../utils/logger';

export interface AuthMailer {
  sendPasswordResetEmail(to: string, resetUrl: string, expiresInMinutes: number): Promise<void>;
  sendPasswordChangedEmail(to: string): Promise<void>;
}

interface MailMessage {
  to: string;
  subject: string;
  text: string;
  html: string;
}

const escapeHtml = (value: string): string =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

export class SmtpAuthMailer implements AuthMailer {
  private transporter: Transporter | undefined;

  public async sendPasswordResetEmail(to: string, resetUrl: string, expiresInMinutes: number): Promise<void> {
    const safeUrl = escapeHtml(resetUrl);
    await this.send({
      to,
      subject: 'Reset your TruFinity password',
      text: [
        'We received a request to reset the password for your TruFinity account.',
        '',
        `Reset your password: ${resetUrl}`,
        '',
        `This link expires in ${expiresInMinutes} minutes and can only be used once.`,
        'If you did not request a password reset, you can ignore this email; your password will not change.',
      ].join('\n'),
      html: `<p>We received a request to reset the password for your TruFinity account.</p>
<p><a href="${safeUrl}">Reset your password</a></p>
<p>This link expires in ${expiresInMinutes} minutes and can only be used once.</p>
<p>If you did not request a password reset, you can ignore this email; your password will not change.</p>`,
    }, resetUrl);
  }

  public async sendPasswordChangedEmail(to: string): Promise<void> {
    await this.send({
      to,
      subject: 'Your TruFinity password was changed',
      text: 'The password for your TruFinity account was just changed and all active sessions were signed out.\n\nIf you did not make this change, contact your administrator immediately.',
      html: '<p>The password for your TruFinity account was just changed and all active sessions were signed out.</p><p>If you did not make this change, contact your administrator immediately.</p>',
    });
  }

  private async send(message: MailMessage, developmentLink?: string): Promise<void> {
    if (!env.SMTP_HOST) {
      if (env.NODE_ENV === 'development') {
        // Local convenience only: without SMTP the link would otherwise be unreachable during development.
        logger.warn(`[Auth] SMTP is not configured; email "${message.subject}" was not sent.${developmentLink ? ` Development link: ${developmentLink}` : ''}`);
        return;
      }
      throw new Error('SMTP is not configured; authentication email could not be sent.');
    }

    this.transporter ??= nodemailer.createTransport({
      host: env.SMTP_HOST,
      port: env.SMTP_PORT,
      secure: env.SMTP_SECURE,
      ...(env.SMTP_USER ? { auth: { user: env.SMTP_USER, pass: env.SMTP_PASSWORD } } : {}),
    });
    await this.transporter.sendMail({ from: env.MAIL_FROM, ...message });
  }
}
