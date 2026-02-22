import React from "react";
import styles from "./Button.module.css";

export type ButtonVariant = "default" | "primary" | "ghost" | "danger";

export function Button({
  variant = "default",
  compact,
  className,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  compact?: boolean;
}) {
  const classes = [
    styles.btn,
    variant !== "default" ? styles[variant] : null,
    compact ? styles.compact : null,
    className,
  ]
    .filter(Boolean)
    .join(" ");

  return <button className={classes} {...props} />;
}
