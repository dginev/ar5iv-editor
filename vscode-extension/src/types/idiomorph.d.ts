// Minimal type surface for idiomorph (ships no types). We use only `morph`.
declare module "idiomorph" {
  export const Idiomorph: {
    morph(
      oldNode: Element,
      newContent: Element | string,
      options?: { morphStyle?: "innerHTML" | "outerHTML"; [key: string]: unknown },
    ): void;
  };
}
