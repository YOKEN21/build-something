export type CatalogResource = {
  name: string;
  arn: string;
  environment: "dev" | "prod";
  account: string;
  owner: string;
};

export type AuthorizationScope = {
  bucket: string;
  prefix: string;
  bucketArn: string;
  objectResource: string;
  bucketActions: string[];
  objectActions: string[];
};

export type AuthorizationRecord = {
  id: string;
  consumer: string;
  access: string;
  environment: "dev" | "prod";
  sameAccountOnly: boolean;
  account: string | null;
  scope: AuthorizationScope;
  ownerApproval: string;
};

export type ServiceOwner = {
  service: string;
  owner: string;
};

export type ParsedCatalog = {
  resources: CatalogResource[];
  authorizations: AuthorizationRecord[];
  serviceOwners: ServiceOwner[];
};

export type CatalogParseResult =
  | { ok: true; catalog: ParsedCatalog }
  | { ok: false; reason: string };

function splitRow(line: string): string[] | undefined {
  const trimmed = line.trim();
  if (!trimmed.startsWith("|")) {
    return undefined;
  }
  const cells = trimmed.split("|").slice(1, -1).map((cell) => cell.trim());
  if (cells.length === 0) {
    return undefined;
  }
  return cells;
}

function isSeparator(cells: string[]): boolean {
  return cells.every((cell) => /^:?-{3,}:?$/.test(cell));
}

function tables(markdown: string): string[][][] {
  const lines = markdown.split(/\r?\n/);
  const found: string[][][] = [];
  let current: string[][] = [];
  for (const line of lines) {
    const cells = splitRow(line);
    if (cells === undefined) {
      if (current.length > 0) {
        found.push(current);
        current = [];
      }
      continue;
    }
    current.push(cells);
  }
  if (current.length > 0) {
    found.push(current);
  }
  return found;
}

function headerIndex(rows: string[][], header: string): number {
  const headerRow = rows[0];
  if (headerRow === undefined) {
    return -1;
  }
  return headerRow.findIndex((cell) => cell.toLowerCase() === header.toLowerCase());
}

function environmentOf(cell: string): "dev" | "prod" | undefined {
  const text = cell.trim().toLowerCase();
  if (text === "dev" || text === "dev only") {
    return "dev";
  }
  if (text === "prod" || text === "prod only") {
    return "prod";
  }
  return undefined;
}

function firstCode(cell: string): string | undefined {
  const quoted = cell.match(/`([^`]+)`/);
  if (quoted?.[1]) {
    return quoted[1].trim();
  }
  const token = cell.trim().split(/\s+/)[0];
  return token && token.length > 0 ? token : undefined;
}

function parseScope(cell: string): AuthorizationScope | undefined {
  const plain = cell.replace(/`/g, "");
  const list = plain.match(/s3:ListBucket on (arn:aws:s3:::([a-z0-9.-]+))/);
  const object = plain.match(/s3:GetObject on (arn:aws:s3:::([a-z0-9.-]+)\/([A-Za-z0-9._-]+)\/\*)/);
  const prefix = plain.match(/prefix ([A-Za-z0-9._-]+\/)/);
  if (!list?.[1] || !list[2] || !object?.[1] || !object[2] || !object[3] || !prefix?.[1]) {
    return undefined;
  }
  if (list[2] !== object[2] || `${object[3]}/` !== prefix[1]) {
    return undefined;
  }
  return {
    bucket: list[2],
    prefix: prefix[1],
    bucketArn: list[1],
    objectResource: object[1],
    bucketActions: ["s3:ListBucket"],
    objectActions: ["s3:GetObject"],
  };
}

function dataRows(table: string[][]): string[][] | undefined {
  if (table.length < 3 || table[1] === undefined || !isSeparator(table[1])) {
    return undefined;
  }
  return table.slice(2);
}

/**
 * Read owners and authorization records from the service-catalog Markdown.
 * A row that cannot be parsed fails the whole read. Nothing here invents a record.
 */
export function parseCatalog(markdown: string): CatalogParseResult {
  if (markdown.trim().length === 0) {
    return { ok: false, reason: "catalog markdown is empty" };
  }
  const parsed = tables(markdown);
  const resourceTable = parsed.find((table) => table[0]?.[0] === "Name" && table[0].includes("ARN"));
  const authTable = parsed.find((table) => table[0]?.[0] === "ID" && table[0].includes("Consumer"));
  const serviceTable = parsed.find((table) => table[0]?.[0] === "Service" && table[0].includes("Owner"));
  if (resourceTable === undefined) {
    return { ok: false, reason: "catalog resources table cannot be parsed" };
  }
  if (authTable === undefined) {
    return { ok: false, reason: "catalog authorization table cannot be parsed" };
  }

  const resources: CatalogResource[] = [];
  const resourceRows = dataRows(resourceTable);
  if (resourceRows === undefined) {
    return { ok: false, reason: "catalog resources table cannot be parsed" };
  }
  const nameIndex = headerIndex(resourceTable, "Name");
  const arnIndex = headerIndex(resourceTable, "ARN");
  const envIndex = resourceTable[0]?.findIndex((cell) => cell.toLowerCase() === "environment") ?? -1;
  const accountIndex = resourceTable[0]?.findIndex((cell) => cell.toLowerCase().startsWith("account")) ?? -1;
  const ownerIndex = headerIndex(resourceTable, "Owner");
  if ([nameIndex, arnIndex, envIndex, accountIndex, ownerIndex].some((index) => index < 0)) {
    return { ok: false, reason: "catalog resources table cannot be parsed" };
  }
  for (const row of resourceRows) {
    const name = firstCode(row[nameIndex] ?? "");
    const arn = firstCode(row[arnIndex] ?? "");
    const environment = environmentOf(row[envIndex] ?? "");
    const account = (row[accountIndex] ?? "").replace(/`/g, "").trim();
    const owner = firstCode(row[ownerIndex] ?? "");
    if (!name || !arn || !environment || !/^`?\d{12}`?$/.test((row[accountIndex] ?? "").trim()) || !owner) {
      return { ok: false, reason: "a catalog resource row cannot be parsed" };
    }
    if (!/^\d{12}$/.test(account)) {
      return { ok: false, reason: "a catalog resource row cannot be parsed" };
    }
    resources.push({ name, arn, environment, account, owner });
  }

  const authorizations: AuthorizationRecord[] = [];
  const authRows = dataRows(authTable);
  if (authRows === undefined) {
    return { ok: false, reason: "catalog authorization table cannot be parsed" };
  }
  const columns = ["ID", "Consumer", "Access", "Environment", "Account", "Approved scope", "Owner approval"];
  const indexes = columns.map((column) => headerIndex(authTable, column));
  if (indexes.some((index) => index < 0)) {
    return { ok: false, reason: "catalog authorization table cannot be parsed" };
  }
  for (const row of authRows) {
    const id = (row[indexes[0] ?? -1] ?? "").trim();
    const consumer = firstCode(row[indexes[1] ?? -1] ?? "");
    const access = (row[indexes[2] ?? -1] ?? "").trim().toLowerCase();
    const environment = environmentOf(row[indexes[3] ?? -1] ?? "");
    const accountCell = row[indexes[4] ?? -1] ?? "";
    const scope = parseScope(row[indexes[5] ?? -1] ?? "");
    const ownerApproval = firstCode(row[indexes[6] ?? -1] ?? "");
    const sameAccountOnly = /same account/i.test(accountCell);
    const accountMatch = accountCell.match(/\d{12}/);
    const account = accountMatch?.[0] ?? null;
    if (!/^AUTH-[A-Z0-9-]+$/.test(id) || !consumer || !environment || !scope || !ownerApproval) {
      return { ok: false, reason: `authorization row ${id || "(missing id)"} cannot be parsed` };
    }
    if (!sameAccountOnly && account === null) {
      return { ok: false, reason: `authorization row ${id} cannot be parsed` };
    }
    authorizations.push({
      id,
      consumer,
      access,
      environment,
      sameAccountOnly,
      account,
      scope,
      ownerApproval,
    });
  }

  const serviceOwners: ServiceOwner[] = [];
  if (serviceTable !== undefined) {
    const serviceRows = dataRows(serviceTable);
    const serviceIndex = headerIndex(serviceTable, "Service");
    const ownerColumn = headerIndex(serviceTable, "Owner");
    if (serviceRows === undefined || serviceIndex < 0 || ownerColumn < 0) {
      return { ok: false, reason: "catalog services table cannot be parsed" };
    }
    for (const row of serviceRows) {
      const service = firstCode(row[serviceIndex] ?? "");
      const owner = firstCode(row[ownerColumn] ?? "");
      if (!service || !owner) {
        return { ok: false, reason: "a catalog service row cannot be parsed" };
      }
      serviceOwners.push({ service, owner });
    }
  }

  return { ok: true, catalog: { resources, authorizations, serviceOwners } };
}
