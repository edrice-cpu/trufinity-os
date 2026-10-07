import type { Metadata } from "next";
import { ForgotPasswordForm } from "@/components/auth/forgot-password-form";
import { AuthCard } from "../auth-card";

export const metadata: Metadata = {
  title: "Forgot password · TruFinity",
  robots: { index: false, follow: false },
};

export default function ForgotPasswordPage() {
  return (
    <AuthCard
      title="Forgot your password?"
      description="Enter the email address for your account and we'll send you a link to reset your password."
    >
      <ForgotPasswordForm />
    </AuthCard>
  );
}
