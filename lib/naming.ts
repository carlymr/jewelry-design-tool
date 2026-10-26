// The material naming standard (GRA-32), shared by the receipt extractor and
// the photo identifier so both name things the same way. Interpolated into
// their prompts; keep the wording here, not in the routes.

export const NAMING_CONVENTION = `NAMING CONVENTION — every item name follows these slots, in this order, nothing else:
[Material] [Type] [Size] [Shape] [Cut]
Examples: "Kyanite Beads 3mm Round Faceted", "Galaxy Tiger Eye Beads 8mm Round", "Toho Seed Beads 11/0 Pale Honey Luster", "Iron Tiger Eye Cabochon 30x24mm Oval", "Antique Silver Bezel Setting 27mm Round", "Hematite Beads 4x2mm Arrow", "Sterling Silver Chain 2mm Cable", "Gold Spacer Beads 4mm Round".
- Material: the stone or metal. Keep a variety, finish, or treatment word only when it is part of the stone's trade name or separates two distinct varieties (Black Agate, Ocean Jasper, Galaxy Tiger Eye, Champagne Gold Hematite, Light Green Garnet vs Moss Green Garnet, Synthetic Hematite, Monarch Opal Doublet). Drop plain descriptive colors — "Blue Kyanite" is "Kyanite", "Dark Red Garnet" is "Garnet"; the stored visual carries color. For metal findings the plating IS the material (Antique Silver, Gold, Gunmetal, Rhodium, Sterling Silver).
- Type: Beads, Seed Beads, Spacer Beads, Cabochon, Bezel Setting, Pinch Bail, Chain, Clasp, Charms, Jump Rings, Connector, Links, Cord, Wire, Thread.
- Size: millimeters; "LxW" for non-round; ranges like "3-4mm"; seed beads by aught ("11/0"); cabochons by face ("30x24mm"); chain by link size.
- Shape: Round, Rondelle, Cube, Tube, Chip, Nugget, Arrow, Teardrop, Oval, Hexagon, Bicone, Flower… Omit only where the type implies it (Seed Beads, Chain, Cord).
- Cut, last: Faceted, Star Cut, Matte, AB — omitted when smooth. "Faceted" always comes after the shape ("Round Faceted", never "Faceted Round").
- Seed beads: "Toho Seed Beads 11/0" + the color name as the maker prints it ("Pale Honey Luster"); no color codes — those belong in the provenance fields.
- Never include pack counts or quantities in the name (no "1200Pcs", "50-Pack") — quantity is a separate field.
- Strip marketing language ("Premium", "Genuine", "Grade AAA", "for Jewelry Making DIY", brand slogans). Keep only what identifies the material.

`;

/** Why a material name breaks the standard, or null when it is fine. A mixed
 * or assorted name means the item is several materials, which should be named
 * one at a time; a slash or "or" means the name is two guesses. */
export function namingIssue(name: string): string | null {
  if (/\bmix(ed)?\b|\bassort|\brandom\b/i.test(name)) {
    return "This name looks like it covers more than one stone. Consider adding each stone as its own material.";
  }
  if (/\s\/\s|\bor\b/i.test(name)) {
    return "This name may cover two stones. If you can only see one, name that one and mark it low confidence.";
  }
  return null;
}
