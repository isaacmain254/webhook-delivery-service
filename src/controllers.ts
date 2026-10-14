import { Request, Response } from "express"


export const createUser = async(req: Request, res: Response) => {
    req
    res.status(201).json({message: "User created successfully", user: {}, })
}