import { useEffect, useState } from "react";

interface ArtworkPalette {
  accent: string;
  accentStrong: string;
  accentSoft: string;
  accentGlow: string;
}

const fallbackPalette: ArtworkPalette = {
  accent: "rgb(242, 126, 90)",
  accentStrong: "rgb(255, 184, 136)",
  accentSoft: "rgba(242, 126, 90, 0.18)",
  accentGlow: "rgba(242, 126, 90, 0.34)",
};

function clampChannel(value: number): number {
  return Math.max(0, Math.min(255, Math.round(value)));
}

function mixChannel(value: number, target: number, amount: number): number {
  return clampChannel(value + (target - value) * amount);
}

function toPalette(red: number, green: number, blue: number): ArtworkPalette {
  const accent = `rgb(${red}, ${green}, ${blue})`;
  const accentStrong = `rgb(${mixChannel(red, 255, 0.32)}, ${mixChannel(green, 232, 0.32)}, ${mixChannel(blue, 190, 0.32)})`;
  const accentSoft = `rgba(${red}, ${green}, ${blue}, 0.18)`;
  const accentGlow = `rgba(${red}, ${green}, ${blue}, 0.34)`;

  return { accent, accentStrong, accentSoft, accentGlow };
}

export function useArtworkAccent(imageUrl?: string): ArtworkPalette {
  const [palette, setPalette] = useState<ArtworkPalette>(fallbackPalette);

  useEffect(() => {
    if (!imageUrl) {
      setPalette(fallbackPalette);
      return;
    }

    let cancelled = false;
    const image = new Image();
    image.crossOrigin = "anonymous";

    image.onload = () => {
      if (cancelled) {
        return;
      }

      try {
        const canvas = document.createElement("canvas");
        const context = canvas.getContext("2d");

        if (!context) {
          setPalette(fallbackPalette);
          return;
        }

        const size = 24;
        canvas.width = size;
        canvas.height = size;
        context.drawImage(image, 0, 0, size, size);
        const pixels = context.getImageData(0, 0, size, size).data;

        let redTotal = 0;
        let greenTotal = 0;
        let blueTotal = 0;
        let weightTotal = 0;

        for (let index = 0; index < pixels.length; index += 4) {
          const alpha = pixels[index + 3] / 255;
          if (alpha < 0.1) {
            continue;
          }

          const red = pixels[index];
          const green = pixels[index + 1];
          const blue = pixels[index + 2];
          const saturation = Math.max(red, green, blue) - Math.min(red, green, blue);
          const weight = alpha * (0.4 + saturation / 255);

          redTotal += red * weight;
          greenTotal += green * weight;
          blueTotal += blue * weight;
          weightTotal += weight;
        }

        if (!weightTotal) {
          setPalette(fallbackPalette);
          return;
        }

        const red = mixChannel(redTotal / weightTotal, 255, 0.06);
        const green = mixChannel(greenTotal / weightTotal, 208, 0.04);
        const blue = mixChannel(blueTotal / weightTotal, 148, 0.02);

        setPalette(toPalette(red, green, blue));
      } catch {
        setPalette(fallbackPalette);
      }
    };

    image.onerror = () => {
      if (!cancelled) {
        setPalette(fallbackPalette);
      }
    };

    image.src = imageUrl;

    return () => {
      cancelled = true;
    };
  }, [imageUrl]);

  return palette;
}
