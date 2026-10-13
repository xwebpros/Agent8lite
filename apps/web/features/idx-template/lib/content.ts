"use client";
import { useTemplateSite } from "../context";
export function useSiteContent() {
  return { data: useTemplateSite().content };
}
