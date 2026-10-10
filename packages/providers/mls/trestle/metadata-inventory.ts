import { TrestleError } from "./safety";

export interface PropertySchemaInventory {
  fields: { name: string; type: string }[];
  navigation: { name: string; type: string }[];
}

/** Bounded catalogue extraction only; this does not determine licensed field rights. */
export function propertySchemaInventory(xml: string): PropertySchemaInventory {
  const bad = () => new TrestleError("TRESTLE_BAD_METADATA_RESPONSE");
  if (
    Buffer.byteLength(xml, "utf8") > 4 * 1024 * 1024 ||
    !/^\s*(?:<\?xml[^>]*>\s*)?<([A-Za-z_][\w.-]*:)?Edmx\b/.test(xml) ||
    /<!DOCTYPE|<!ENTITY|<!\[CDATA\[/i.test(xml)
  )
    throw bad();
  const text = xml.replace(/<!--[\s\S]*?-->/g, "");
  const attribute = (attributes: string, key: string) => {
    const matches = [...attributes.matchAll(new RegExp(`(?:^|\\s)${key}\\s*=\\s*(["'])(.*?)\\1`, "g"))];
    if (matches.length !== 1) throw bad();
    return matches[0][2];
  };
  const entities = [
    ...text.matchAll(/<((?:[A-Za-z_][\w.-]*:)?EntityType)\b([^>]*)>([\s\S]*?)<\/\1\s*>/g),
  ].filter((match) => attribute(match[2], "Name") === "Property");
  if (entities.length !== 1) throw bad();
  const fields: PropertySchemaInventory["fields"] = [];
  const navigation: PropertySchemaInventory["navigation"] = [];
  const names = new Set<string>();
  for (const match of entities[0][3].matchAll(
    /<(?:[A-Za-z_][\w.-]*:)?(Property|NavigationProperty)\b([^>]*)\/?\s*>/g,
  )) {
    const name = attribute(match[2], "Name");
    const type = attribute(match[2], "Type");
    if (
      !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(name) ||
      !/^(?:Collection\()?([A-Za-z_][A-Za-z0-9_.]*)(?:\))?$/.test(type) ||
      type.startsWith("Collection(") !== type.endsWith(")") ||
      names.has(name)
    )
      throw bad();
    names.add(name);
    (match[1] === "Property" ? fields : navigation).push({ name, type });
  }
  if (
    fields.length === 0 ||
    fields.length > 4096 ||
    navigation.length > 32 ||
    ![
      "ListingKey",
      "OriginatingSystemName",
      "StandardStatus",
      "InternetEntireListingDisplayYN",
      "InternetAddressDisplayYN",
    ].every((name) => fields.some((field) => field.name === name))
  )
    throw bad();
  return { fields, navigation };
}
