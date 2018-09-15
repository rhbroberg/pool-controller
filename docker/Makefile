
all:	docker-images

docker-images:	proxy letsencrypt-companion

prep:
	git clone https://github.com/rhbroberg/nginx-proxy.git
	git clone https://github.com/JrCs/docker-letsencrypt-nginx-proxy-companion.git
	@touch $@

proxy:	prep nginx-proxy/docker-gen
	docker build -t rhbroberg/nginx-proxy nginx-proxy
	@touch $@

letsencrypt-companion:	prep
	docker build -t rhbroberg/docker-letsencrypt-nginx-proxy-companion docker-letsencrypt-nginx-proxy-companion 
	@touch $@

push:	push-proxy push-letsencrypt-companion
	@touch $@

push-proxy:	proxy
	docker push rhbroberg/nginx-proxy
	@touch $@

push-letsencrypt-companion:	letsencrypt-companion
	docker push rhbroberg/docker-letsencrypt-nginx-proxy-companion
	@touch $@

nginx-proxy/docker-gen:	letsencrypt-companion
	docker rm -f temp-to-copy > /dev/null 2>&1 || true
	docker run -d --name temp-to-copy --rm rhbroberg/docker-letsencrypt-nginx-proxy-companion sleep 30
	docker cp temp-to-copy:/usr/local/bin/docker-gen nginx-proxy
	@touch nginx-proxy/docker-gen

clean:
	rm -rf docker-gen push-letsencrypt-companion push-proxy push letsencrypt-companion proxy prep nginx-proxy docker-letsencrypt-nginx-proxy-companion

realclean:	clean
	- docker image rm -f rhbroberg/nginx-proxy rhbroberg/docker-letsencrypt-nginx-proxy-companion > /dev/null 2>&1
