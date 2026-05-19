// imageScale — downscale an uploaded avatar to a tiny square data-URL.
//
// Cluster icons live in `clusterSettings`, which is persisted to
// localStorage; a full-resolution photo would blow the ~5MB quota in a
// few clusters. We crop to a centred square and cap it at 96px, which is
// plenty for a 48px avatar on a 2× display and lands at ~3-8KB of JPEG.

const MAX = 96;

export function downscaleImage(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    if (!file.type.startsWith("image/")) {
      reject(new Error("not an image file"));
      return;
    }
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("could not read file"));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error("could not decode image"));
      img.onload = () => {
        const side = Math.min(img.width, img.height) || 1;
        const sx = (img.width - side) / 2;
        const sy = (img.height - side) / 2;
        const canvas = document.createElement("canvas");
        canvas.width = MAX;
        canvas.height = MAX;
        const ctx = canvas.getContext("2d");
        if (!ctx) { reject(new Error("canvas unavailable")); return; }
        ctx.drawImage(img, sx, sy, side, side, 0, 0, MAX, MAX);
        try {
          // JPEG keeps it small; avatars rarely need transparency.
          resolve(canvas.toDataURL("image/jpeg", 0.85));
        } catch (e) {
          reject(e instanceof Error ? e : new Error("encode failed"));
        }
      };
      img.src = reader.result as string;
    };
    reader.readAsDataURL(file);
  });
}
