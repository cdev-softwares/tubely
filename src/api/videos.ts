import { respondWithJSON } from "./json";
import { BadRequestError, UserForbiddenError, NotFoundError } from "./errors";
import { getBearerToken, validateJWT } from "../auth";
import { getVideo, updateVideo } from "../db/videos";
import { type ApiConfig, cfg } from "../config";
import type { BunRequest } from "bun";

export async function handlerUploadVideo(cfg: ApiConfig, req: BunRequest) {
  const { videoId } = req.params as { videoId?: string };
  if (!videoId) {
    throw new BadRequestError("Invalid video ID");
  }
  
  const token = getBearerToken(req.headers);
  const userID = validateJWT(token, cfg.jwtSecret);
  
  console.log("uploading video", videoId, "by user", userID);

  const video = getVideo(cfg.db, videoId);
  if (!video) throw new NotFoundError("No video corresponding to this ID in the database");
  if (userID !== video.userID) throw new UserForbiddenError("User is not the owner of the video");
  
  const formData = await req.formData();
  const file = formData.get("video");
  if (!(file instanceof File)) {
    throw new BadRequestError("Video file is missing");
  }
  
  const MAX_UPLOAD_SIZE: number = 1 << 30
  if (file.size > MAX_UPLOAD_SIZE) throw new BadRequestError("Size of the video is too big");

  const fileType = file.type;
  if (fileType !== "video/mp4") throw new BadRequestError("The file sent should be a video");

  const videoBuffer = await file.arrayBuffer();
  const fileExtension = fileType.split("/")[1];
  const fileName = `${videoId}.${fileExtension}`;

  const tempVidFilePath = `${cfg.assetsRoot}/${fileName}`;

  try {

  await Bun.write(tempVidFilePath, videoBuffer);
  const s3Vid = cfg.s3Client.file(fileName);
  await s3Vid.write(Bun.file(tempVidFilePath), {type: "video/mp4"})  
    
  video.videoURL = `https://${cfg.s3Bucket}.s3.${cfg.s3Region}.amazonaws.com/${fileName}`;
  await updateVideo(cfg.db, video);

  } finally {
  
  const isFileThere = await Bun.file(tempVidFilePath).exists();
  if (isFileThere) await Bun.file(tempVidFilePath).delete();
  
  }

  return respondWithJSON(200, null);
}
