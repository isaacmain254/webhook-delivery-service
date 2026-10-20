import prisma from '../db.js'

export async function createUser(username: string, apiKeyHash: string) {
  return await prisma.user.create({
    data: { username, apiKeyHash },
    select: { id: true, username: true },
  })
}
