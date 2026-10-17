import fs from "node:fs";
import path from "node:path";

// ---- Store offer images. ----
// The client downloads an offer's picture from images.standard / images.feature (its ImageURL); retail served
// them from Phoenix's CDN. The folder holds the items' own icons, one PNG per catalog id (lower case), extracted
// from the game's textures: store-images (1.4.4) or store-images-1147 (the 1.14.7 paks, PORT-1.14.7 doc 18).
// routes/store.ts serves them at /store-images/<file>.
export const STORE_IMAGES_DIR = path.join(process.cwd(), process.env.TARGET_GAME_VERSION === "1.14.7" ? "store-images-1147" : "store-images");
let StoreImageFiles: Set<string> | undefined;

// "<catalog id>.png" when the folder has that icon
export function StoreImageFile(CatalogId: unknown){
    StoreImageFiles ??= new Set(fs.existsSync(STORE_IMAGES_DIR) ? fs.readdirSync(STORE_IMAGES_DIR) : []);
    const File = typeof CatalogId === "string" ? `${CatalogId.toLowerCase()}.png` : undefined;
    return File != undefined && StoreImageFiles.has(File) ? File : undefined;
}

// The offer images for the first of these items that has an icon, as URLs on the host the client called (so
// they work behind the relay too), or {} when none has one
export function StoreImages(req: any, CatalogIds: unknown[]): { standard?: string, feature?: string } {
    for(const CatalogId of CatalogIds){
        const File = StoreImageFile(CatalogId);
        if(File == undefined) continue;
        const Url = `${req.protocol}://${req.get("host")}/store-images/${File}`;
        return { standard: Url, feature: Url };
    }
    return {};
}
