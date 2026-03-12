export interface LabColor {
  l: number;
  a: number;
  b: number;
}

const clampByte = (value: number) =>
  Math.max(0, Math.min(255, Math.round(value)));

const srgbToLinear = (value: number) => {
  const normalized = value / 255;
  return normalized <= 0.04045
    ? normalized / 12.92
    : ((normalized + 0.055) / 1.055) ** 2.4;
};

const linearToSrgb = (value: number) => {
  const normalized =
    value <= 0.0031308
      ? value * 12.92
      : 1.055 * Math.pow(value, 1 / 2.4) - 0.055;
  return clampByte(normalized * 255);
};

export const rgbToXyz = (
  red: number,
  green: number,
  blue: number
): [number, number, number] => {
  const r = srgbToLinear(red);
  const g = srgbToLinear(green);
  const b = srgbToLinear(blue);

  return [
    r * 0.4124564 + g * 0.3575761 + b * 0.1804375,
    r * 0.2126729 + g * 0.7151522 + b * 0.072175,
    r * 0.0193339 + g * 0.119192 + b * 0.9503041
  ];
};

const xyzToRgb = (
  x: number,
  y: number,
  z: number
): [number, number, number] => {
  const linearR = x * 3.2404542 + y * -1.5371385 + z * -0.4985314;
  const linearG = x * -0.969266 + y * 1.8760108 + z * 0.041556;
  const linearB = x * 0.0556434 + y * -0.2040259 + z * 1.0572252;

  return [
    linearToSrgb(linearR),
    linearToSrgb(linearG),
    linearToSrgb(linearB)
  ];
};

const whitePoint: [number, number, number] = [0.95047, 1, 1.08883];

const xyzToLabValue = (value: number) =>
  value > 0.008856 ? Math.cbrt(value) : 7.787 * value + 16 / 116;

const labToXyzValue = (value: number) => {
  const cube = value ** 3;
  return cube > 0.008856 ? cube : (value - 16 / 116) / 7.787;
};

export const rgbToLab = (red: number, green: number, blue: number): LabColor => {
  const [x, y, z] = rgbToXyz(red, green, blue);
  const fx = xyzToLabValue(x / whitePoint[0]);
  const fy = xyzToLabValue(y / whitePoint[1]);
  const fz = xyzToLabValue(z / whitePoint[2]);

  return {
    l: 116 * fy - 16,
    a: 500 * (fx - fy),
    b: 200 * (fy - fz)
  };
};

export const labToRgb = (
  lightness: number,
  greenRed: number,
  blueYellow: number
): [number, number, number] => {
  const fy = (lightness + 16) / 116;
  const fx = greenRed / 500 + fy;
  const fz = fy - blueYellow / 200;

  const x = whitePoint[0] * labToXyzValue(fx);
  const y = whitePoint[1] * labToXyzValue(fy);
  const z = whitePoint[2] * labToXyzValue(fz);

  return xyzToRgb(x, y, z);
};

export const labDistance = (first: LabColor, second: LabColor) =>
  (first.l - second.l) ** 2 +
  (first.a - second.a) ** 2 +
  (first.b - second.b) ** 2;

export const rgbToHex = (red: number, green: number, blue: number) =>
  `#${[red, green, blue]
    .map((channel) => clampByte(channel).toString(16).padStart(2, '0'))
    .join('')}`;

export const labHue = ({ a, b }: LabColor) => {
  const angle = Math.atan2(b, a);
  return angle >= 0 ? angle : Math.PI * 2 + angle;
};

export const luminanceLabel = (index: number) => `Color ${index + 1}`;
