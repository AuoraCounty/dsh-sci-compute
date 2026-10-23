export function retain(ctx, open) {
  if (typeof ctx?.effect === "function") {
    ctx.effect(open);
    return;
  }
  open();
}
