/** Fixed physical properties for the destructible page surface. */
export const WOOD = Object.freeze({
  toughness: 1.35,
  density: 1.25,
  flammability: 1,
  burnRate: 1,
  conductivity: 0.03,
  corrosionResistance: 0.3,
  restitution: 0.1,
  color: "#9b6a38",
} as const);
