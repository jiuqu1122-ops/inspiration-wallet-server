import nodemailer from 'nodemailer';
import { env } from '../../config/env.js';

export function canSendVerificationEmail() {
  return Boolean(env.SMTP_HOST && env.SMTP_FROM);
}

export async function sendVerificationEmail(email: string, code: string) {
  if (!canSendVerificationEmail()) {
    throw new Error('Email verification is not configured');
  }

  const transporter = nodemailer.createTransport({
    host: env.SMTP_HOST,
    port: env.SMTP_PORT,
    secure: env.smtpSecure,
    ...(env.SMTP_USER
      ? { auth: { user: env.SMTP_USER, pass: env.SMTP_PASSWORD } }
      : {}),
  });

  await transporter.sendMail({
    from: env.SMTP_FROM,
    to: email,
    subject: `${code}｜灵感抽屉登录验证码`,
    text: `你的灵感抽屉验证码是 ${code}。验证码将在 ${env.EMAIL_CODE_TTL_MINUTES} 分钟后失效，请勿转发给任何人。`,
    html: `
      <div style="font-family:Arial,'Microsoft YaHei',sans-serif;max-width:520px;margin:0 auto;padding:32px;color:#172033">
        <div style="font-size:14px;font-weight:700;color:#2f72ff">INSPIRATION DRAWER</div>
        <h1 style="margin:16px 0 8px;font-size:24px">登录灵感抽屉</h1>
        <p style="margin:0 0 24px;color:#667085;line-height:1.7">请输入下面的验证码完成邮箱验证。验证码仅可使用一次。</p>
        <div style="padding:20px;border-radius:16px;background:#eef4ff;color:#2058d8;font-size:34px;font-weight:800;letter-spacing:10px;text-align:center">${code}</div>
        <p style="margin:20px 0 0;color:#98a2b3;font-size:12px">${env.EMAIL_CODE_TTL_MINUTES} 分钟内有效。如果不是你本人操作，请忽略本邮件。</p>
      </div>
    `,
  });
}
