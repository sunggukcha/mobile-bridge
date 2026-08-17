import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Keep image text independent of the host's installed fonts.  The bridge can
// run on minimal Linux images where resvg's system-font fallback has no Hangul
// coverage and silently paints tofu boxes instead.
export const KOREAN_IMAGE_FONT_FAMILY = 'Nanum Gothic Coding';
export const KOREAN_IMAGE_FONT_FILE = fileURLToPath(new URL(
  '../node_modules/nanum-gothic-coding/fonts/NanumGothicCoding-Regular.ttf',
  import.meta.url,
));
export const KOREAN_IMAGE_BOLD_FONT_FILE = fileURLToPath(new URL(
  '../node_modules/nanum-gothic-coding/fonts/NanumGothicCoding-Bold.ttf',
  import.meta.url,
));
export const KOREAN_IMAGE_FONT_FILES = Object.freeze([
  KOREAN_IMAGE_FONT_FILE,
  KOREAN_IMAGE_BOLD_FONT_FILE,
]);

export function missingKoreanImageFontFiles() {
  return KOREAN_IMAGE_FONT_FILES.filter((fontFile) => !existsSync(fontFile));
}
