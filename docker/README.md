docker build -f Dockerfile -t rhbroberg/mongo-amd64 .
docker push rhbroberg/mongo-amd64
docker manifest create rhbroberg/mongo-multi:latest rhbroberg/mongo-amd64 andresvidal/rpi3-mongodb3
docker manifest annotate rhbroberg/mongo-multi:latest andresvidal/rpi3-mongodb3 --os linux --arch arm
docker manifest push rhbroberg/mongo-multi:latest
