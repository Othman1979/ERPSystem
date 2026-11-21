export const LAST_BRANDING_KEY = 'erp.lastBranding';

export interface LastBranding {
  nameAr: string;
  nameEn: string | null;
  logo: string | null;
}

export function readLastBranding(): LastBranding | null {
  try {
    const value = JSON.parse(window.localStorage.getItem(LAST_BRANDING_KEY) ?? 'null') as Partial<LastBranding> | null;
    return value && typeof value.nameAr === 'string' && (value.nameEn === null || typeof value.nameEn === 'string') &&
      (value.logo === null || typeof value.logo === 'string')
      ? value as LastBranding
      : null;
  } catch {
    return null;
  }
}

export function saveLastBranding(value: LastBranding): void {
  try {
    window.localStorage.setItem(LAST_BRANDING_KEY, JSON.stringify(value));
  } catch {
    // Branding is optional when storage is unavailable.
  }
}

export function clearLastBranding(): void {
  try {
    window.localStorage.removeItem(LAST_BRANDING_KEY);
  } catch {
    // Branding is optional when storage is unavailable.
  }
}

export function shrinkLogo(dataUrl: string, maxWidth = 160): Promise<string> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => {
      const scale = Math.min(1, maxWidth / image.naturalWidth);
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
      canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
      const context = canvas.getContext('2d');
      if (!context) {
        reject(new Error('Could not scale company logo'));
        return;
      }
      context.drawImage(image, 0, 0, canvas.width, canvas.height);
      const mimeType = dataUrl.startsWith('data:image/jpeg') ? 'image/jpeg' : 'image/png';
      resolve(canvas.toDataURL(mimeType, 0.9));
    };
    image.onerror = () => reject(new Error('Could not load company logo'));
    image.src = dataUrl;
  });
}
