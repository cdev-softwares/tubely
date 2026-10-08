import { getBearerToken, validateJWT } from "../auth";
import { respondWithJSON } from "./json";
import { getVideo, updateVideo } from "../db/videos";
import type { ApiConfig } from "../config";
import type { BunRequest } from "bun";
import { BadRequestError, NotFoundError, UserForbiddenError } from "./errors";
import path from "path";
import { bundlerModuleNameResolver } from "typescript";
import { randomBytes } from "crypto";

type Thumbnail = {
  data: ArrayBuffer;
  mediaType: string;
};

export async function handlerUploadThumbnail(cfg: ApiConfig, req: BunRequest) {
  const { videoId } = req.params as { videoId?: string };
  if (!videoId) {
    throw new BadRequestError("Invalid video ID");
  }

  const token = getBearerToken(req.headers);
  const userID = validateJWT(token, cfg.jwtSecret);

  console.log("uploading thumbnail for video", videoId, "by user", userID);

  const formData = await req.formData();
  const file = formData.get("thumbnail");
  if (!(file instanceof File)) {
    throw new BadRequestError("Thumbnail file is missing");
  }
  const MAX_UPLOAD_SIZE: number = 10 << 20
  if (file.size > MAX_UPLOAD_SIZE) throw new BadRequestError("Size of the upload is too big");
  const fileType = file.type;
  const thumbBuffer = await file.arrayBuffer();

  const fileExtension = fileType.split("/")[1];
  const urlSetter = randomBytes(32).toString("base64url");

  const thumbnailFilePath = path.join(cfg.assetsRoot, `${urlSetter}.${fileExtension}`);
  Bun.write(thumbnailFilePath, thumbBuffer);

  const video = getVideo(cfg.db, videoId);
  if (!video) throw new BadRequestError("Invalid video ID");
  if (userID !== video.userID) throw new UserForbiddenError("User is not the owner of the video");
  
  video.thumbnailURL = `http://localhost:${cfg.port}/${thumbnailFilePath}`;
  await updateVideo(cfg.db, video);

  return respondWithJSON(200, video);
}
